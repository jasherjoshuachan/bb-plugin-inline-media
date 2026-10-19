// Inline Media — frontend.
//
// Three ways to play a media file, from most to least stable:
// 1. Message directives ::video, ::audio and ::media in agent replies
//    (app.slots.messageDirective).
// 2. A "Play media" message action on any message (app.slots.messageAction):
//    it reads the message through the SDK (useSdk().threads.message), finds
//    every media file it refers to and lists them in a "Media" side panel
//    (app.slots.threadPanelAction).
// 3. Best effort: a ▶ button after media file links in rendered messages
//    (a content script reading bb's DOM, rendered through an app overlay
//    bridge). Off with the decorateLinks setting; does nothing if bb's markup
//    changes.
// Everything that names a file is untrusted: it's validated here for a quick
// inline error and again on the server, the only place that touches files.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  experimental_copyToClipboard,
  useBbNavigate,
  useRpc,
  useSdk,
  useSettings,
  type ExperimentalLiveFileTarget,
  type PluginBrowserBbSdk,
  type PluginContentScriptContext,
  type PluginMessageActionContext,
  type PluginMessageDirectiveProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Icon } from "./components/ui/icon";
import { parseMediaAttributes, type MediaOptions } from "./lib/attributes";
import { extractFromText, extractMediaRefs, type MediaRef } from "./lib/extract";
import { formatBytes, formatDuration } from "./lib/format";
import { createLinkDecorator, threadIdFromLocation, type LinkDecorator } from "./lib/link-decorator";
import type { DirectiveName } from "./lib/media";
import { createMountStore, type InlineMountRequest } from "./lib/mount-store";
import { isAbsoluteLike } from "./lib/paths";
import { createPlaybackRegistry } from "./lib/playback";
import { cachedPoster, capturePoster } from "./lib/poster";
import { cn } from "./lib/utils";

const DEFAULT_MAX_HEIGHT = 420;
const playback = createPlaybackRegistry();

const PANEL_ACTION_ID = "media";
const NO_MEDIA = "No video or audio in this message";

type Loaded = {
  url: string;
  name: string;
  sizeBytes: number | null;
  target: ExperimentalLiveFileTarget | null;
  canReveal: boolean;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; media: Loaded }
  | { status: "not-found"; name: string }
  | { status: "error"; message: string };

type PlayError = { kind: "codec" | "network" | "unknown"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useMaxHeight(): number {
  const { values } = useSettings();
  const raw = values?.maxInlineHeight;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_MAX_HEIGHT;
  return Math.min(2000, Math.max(120, Math.round(raw)));
}

function IconButton({
  icon,
  label,
  onClick,
  children,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={children === undefined ? label : undefined}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground",
        "transition-colors duration-150 hover:bg-state-hover hover:text-foreground hover:duration-0",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <Icon name={icon} fallback="Circle" className="size-3.5" aria-hidden />
      {children}
    </button>
  );
}

function InlineNotice({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 px-3 py-2 text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon
        name={tone === "error" ? "AlertTriangle" : "Info"}
        fallback="Circle"
        className="mt-0.5 size-4 shrink-0"
        aria-hidden
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Small inline glyphs: bb's icon set has no film or note icon. */
function KindGlyph({ kind }: { kind: MediaOptions["kind"] }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className="size-4 shrink-0 text-muted-foreground">
      {kind === "video" ? (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10 9.2v5.6c0 .5.5.8.9.5l4.2-2.8a.6.6 0 0 0 0-1l-4.2-2.8c-.4-.3-.9 0-.9.5z" fill="currentColor" />
        </>
      ) : (
        <>
          <path d="M9 18V6l10-2v12" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
          <circle cx="6.5" cy="18" r="2.5" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="16.5" cy="16" r="2.5" stroke="currentColor" strokeWidth="1.6" />
        </>
      )}
    </svg>
  );
}

/** The fallback for invalid attributes: say what's wrong, show the original text. */
function InvalidDirective({ errors, source }: { errors: string[]; source: string }) {
  return (
    <div className="my-2 rounded-md border border-border bg-muted text-sm" data-inline-media-invalid="">
      <InlineNotice tone="error">
        <div>Can't show this media: {errors.join(" ")}</div>
        <code className="mt-1 block truncate text-xs text-muted-foreground" title={source}>
          {source}
        </code>
      </InlineNotice>
    </div>
  );
}

function MediaPlayer({
  options,
  threadId,
  openWorkspaceFile,
  messageSeq = null,
}: {
  options: MediaOptions;
  threadId: string;
  openWorkspaceFile: PluginMessageDirectiveProps["openWorkspaceFile"];
  /** The message the file came from, so the server can check its attachments. */
  messageSeq?: number | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const maxHeight = useMaxHeight();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [duration, setDuration] = useState<number | null>(null);
  const [playError, setPlayError] = useState<PlayError | null>(null);
  const [noPicture, setNoPicture] = useState(false);
  const [poster, setPoster] = useState<string | null>(null);
  const elementRef = useRef<HTMLMediaElement | null>(null);
  /** When the URL was last re-minted after a playback error; limits refreshes to one a minute. */
  const lastRefreshRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const startAppliedRef = useRef(false);
  const resumeAtRef = useRef<number | null>(null);
  const resumePlayRef = useRef(false);

  const load = useCallback(
    async (refresh: boolean, isCancelled: () => boolean) => {
      try {
        const result = await rpc.call("mediaUrl", {
          threadId,
          path: options.file,
          source: options.source,
          ...(messageSeq === null ? {} : { message: { seq: messageSeq } }),
          ...(refresh ? { refresh: true } : {}),
        });
        if (isCancelled()) return;
        if (result.kind === "not-found") {
          setState({ status: "not-found", name: result.name });
          return;
        }
        setState({
          status: "ready",
          media: {
            url: result.url,
            name: result.name,
            sizeBytes: result.sizeBytes,
            target: result.target,
            canReveal: result.canReveal === true,
          },
        });
        if (options.kind === "video") setPoster(cachedPoster(result.url) ?? null);
      } catch (error) {
        if (!isCancelled()) setState({ status: "error", message: errorMessage(error) });
      }
    },
    [rpc, threadId, options.file, options.source, options.kind, messageSeq],
  );

  useEffect(() => {
    let cancelled = false;
    lastRefreshRef.current = null;
    startAppliedRef.current = false;
    setPlayError(null);
    setNoPicture(false);
    setDuration(null);
    setPoster(null);
    setState({ status: "loading" });
    void load(false, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Register the element so starting it pauses every other inline player.
  const unregisterRef = useRef<(() => void) | null>(null);
  const attach = useCallback((element: HTMLMediaElement | null) => {
    unregisterRef.current?.();
    unregisterRef.current = element === null ? null : playback.register(element);
    elementRef.current = element;
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      elementRef.current?.pause();
      unregisterRef.current?.();
      unregisterRef.current = null;
    };
  }, []);

  const onPlay = useCallback(() => {
    const element = elementRef.current;
    if (element !== null) playback.claim(element);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const element = elementRef.current;
    if (element === null) return;
    setDuration(Number.isFinite(element.duration) ? element.duration : null);
    const resumeAt = resumeAtRef.current;
    if (resumeAt !== null) {
      resumeAtRef.current = null;
      element.currentTime = resumeAt;
      if (resumePlayRef.current) {
        resumePlayRef.current = false;
        void element.play().catch(() => undefined);
      }
    } else if (!startAppliedRef.current && options.start !== null) {
      startAppliedRef.current = true;
      const limit = Number.isFinite(element.duration) ? element.duration : Infinity;
      if (options.start < limit) element.currentTime = options.start;
    }
    if (options.kind === "video" && element instanceof HTMLVideoElement) {
      // Audio decoded but no picture: typically HEVC/ProRes without hardware support.
      const pictureless = element.videoWidth === 0 && element.videoHeight === 0;
      setNoPicture(pictureless);
      // First-frame poster from a hidden copy; never touches this element's playback.
      const url = element.currentSrc || element.src;
      if (!pictureless && url && cachedPoster(url) === undefined) {
        void capturePoster(url).then((frame) => {
          if (mountedRef.current && frame !== null && elementRef.current === element) setPoster(frame);
        });
      }
    }
  }, [options.start, options.kind]);

  const onError = useCallback(() => {
    const element = elementRef.current;
    const code = element?.error?.code ?? 0;
    // The preview URL may have expired (or bb restarted): mint a fresh one and
    // carry on where playback stopped. At most once a minute, so a file that
    // really can't be decoded doesn't loop.
    const now = Date.now();
    if (lastRefreshRef.current === null || now - lastRefreshRef.current > 60_000) {
      lastRefreshRef.current = now;
      if (element !== null && element.currentTime > 0) {
        resumeAtRef.current = element.currentTime;
        resumePlayRef.current = !element.paused;
      }
      void load(true, () => !mountedRef.current);
      return;
    }
    if (code === 3 || code === 4) {
      setPlayError({
        kind: "codec",
        message:
          "This browser can't play this file. Its format or codec isn't supported here (HEVC .mov files often aren't), or the file has changed.",
      });
    } else if (code === 2) {
      setPlayError({ kind: "network", message: "The file stopped loading. Try again, or open it in the side panel." });
    } else {
      setPlayError({ kind: "unknown", message: "The file couldn't be played." });
    }
  }, [load]);

  const media = state.status === "ready" ? state.media : null;
  const target = media?.target ?? null;
  const displayName = options.title ?? media?.name ?? options.file.split("/").pop() ?? options.file;

  // Drops (absolute paths) aren't workspace files; they open through their live target.
  const isWorkspaceFile = options.source === "workspace" && !isAbsoluteLike(options.file);
  const canOpenPanel =
    (isWorkspaceFile && openWorkspaceFile !== null) ||
    (target !== null && typeof navigate.experimental_openFilePreview === "function");
  const canOpenExternally = target !== null && typeof navigate.experimental_openFileExternally === "function";

  const openPanel = useCallback(() => {
    let opened = false;
    if (isWorkspaceFile && openWorkspaceFile !== null) {
      opened = openWorkspaceFile(options.file);
    }
    if (!opened && target !== null && typeof navigate.experimental_openFilePreview === "function") {
      opened = navigate.experimental_openFilePreview({ target, location: null });
    }
    if (!opened) toast.error("bb couldn't open this file in the side panel.");
  }, [isWorkspaceFile, options.file, openWorkspaceFile, target, navigate]);

  const openExternally = useCallback(() => {
    if (target === null || typeof navigate.experimental_openFileExternally !== "function") return;
    if (!navigate.experimental_openFileExternally({ target, location: null })) {
      toast.error("bb couldn't open this file in another app.");
    }
  }, [target, navigate]);

  const canReveal = media?.canReveal === true;
  const reveal = useCallback(async () => {
    try {
      await rpc.call("reveal", {
        threadId,
        path: options.file,
        source: options.source,
        ...(messageSeq === null ? {} : { message: { seq: messageSeq } }),
      });
    } catch (error) {
      toast.error(`Couldn't reveal the file: ${errorMessage(error)}`);
    }
  }, [rpc, threadId, options.file, options.source, messageSeq]);

  const copyPath = useCallback(async () => {
    const text = options.file;
    let copied = false;
    try {
      if (typeof experimental_copyToClipboard === "function") {
        copied = await experimental_copyToClipboard({ text });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (copied) toast.success("Path copied");
    else toast.error("Couldn't copy the path.");
  }, [options.file]);

  const retry = useCallback(() => {
    lastRefreshRef.current = Date.now();
    setPlayError(null);
    setNoPicture(false);
    setPoster(null);
    setState({ status: "loading" });
    void load(true, () => !mountedRef.current);
  }, [load]);

  const meta = [formatDuration(duration), formatBytes(media?.sizeBytes ?? null)].filter(
    (part): part is string => part !== null,
  );

  const fallbackButtons = (
    <div className="mt-2 flex flex-wrap gap-1">
      {canOpenPanel ? (
        <IconButton icon="PanelRight" label="Open in side panel" onClick={openPanel}>
          Open in side panel
        </IconButton>
      ) : null}
      {canOpenExternally ? (
        <IconButton icon="ExternalLink" label="Open in another app" onClick={openExternally}>
          Open in another app
        </IconButton>
      ) : null}
      {canReveal ? (
        <IconButton icon="FolderOpen" label="Reveal in Finder" onClick={() => void reveal()}>
          Reveal in Finder
        </IconButton>
      ) : null}
      <IconButton icon="RotateCcw" label="Try again" onClick={retry}>
        Try again
      </IconButton>
    </div>
  );

  let body: ReactNode;
  if (state.status === "loading") {
    body = <InlineNotice tone="info">Loading {options.kind}…</InlineNotice>;
  } else if (state.status === "not-found") {
    body = (
      <InlineNotice tone="error">
        File not found: <code className="text-xs">{options.file}</code>
        {options.source === "thread-storage" ? " (in thread storage)" : ""}
      </InlineNotice>
    );
  } else if (state.status === "error") {
    body = <InlineNotice tone="error">{state.message}</InlineNotice>;
  } else if (playError !== null) {
    body = (
      <InlineNotice tone="error">
        {playError.message}
        {fallbackButtons}
      </InlineNotice>
    );
  } else {
    const common = {
      src: state.media.url,
      controls: true,
      preload: "metadata" as const,
      loop: options.loop,
      muted: options.muted,
      onPlay,
      onLoadedMetadata,
      onError,
    };
    body = (
      <>
        {options.kind === "video" ? (
          <video
            key={state.media.url}
            ref={attach}
            {...common}
            playsInline
            {...(poster === null ? {} : { poster })}
            className="block w-full bg-black object-contain"
            style={{ maxHeight }}
          />
        ) : (
          <audio key={state.media.url} ref={attach} {...common} className="block w-full px-2 pb-2" />
        )}
        {noPicture ? (
          <InlineNotice tone="info">
            No picture: this browser can't decode the video track (common for HEVC or ProRes .mov). The sound still plays.
            {fallbackButtons}
          </InlineNotice>
        ) : null}
      </>
    );
  }

  return (
    <div
      className="my-2 overflow-hidden rounded-lg border border-border bg-muted/40"
      data-inline-media=""
      data-inline-media-kind={options.kind}
    >
      <div className="flex min-w-0 items-center gap-2 px-2 py-1">
        <KindGlyph kind={options.kind} />
        <span className="min-w-0 truncate text-sm font-medium" title={options.file}>
          {displayName}
        </span>
        {meta.length > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{meta.join(" · ")}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">
          {canOpenPanel ? <IconButton icon="PanelRight" label="Open in side panel" onClick={openPanel} /> : null}
          {canReveal ? <IconButton icon="FolderOpen" label="Reveal in Finder" onClick={() => void reveal()} /> : null}
          <IconButton icon="Copy" label="Copy path" onClick={() => void copyPath()} />
        </span>
      </div>
      {body}
    </div>
  );
}

function directiveComponent(directive: DirectiveName) {
  function MediaDirective({ attributes, source, message, openWorkspaceFile }: PluginMessageDirectiveProps) {
    const parsed = useMemo(() => parseMediaAttributes(attributes, directive), [attributes]);
    if (!parsed.ok) return <InvalidDirective errors={parsed.errors} source={source} />;
    if (typeof message?.threadId !== "string" || message.threadId.length === 0) {
      return <InvalidDirective errors={["This message has no thread."]} source={source} />;
    }
    return <MediaPlayer options={parsed.value} threadId={message.threadId} openWorkspaceFile={openWorkspaceFile} />;
  }
  MediaDirective.displayName = `InlineMedia(${directive})`;
  return MediaDirective;
}

// ---------------------------------------------------------------------------
// Route 2: the "Play media" message action and its side panel.

/** The panel's params: `{ messageSeq }`. Untrusted (persisted with the tab). */
function panelMessageSeq(params: unknown): number | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const seq = (params as Record<string, unknown>).messageSeq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

/** A reference from a message, as player options (validated like a directive). */
function refOptions(ref: MediaRef): MediaOptions | null {
  const parsed = parseMediaAttributes({ file: ref.file, source: ref.source }, ref.kind);
  if (!parsed.ok) return null;
  return { ...parsed.value, title: ref.name };
}

type PanelState =
  | { status: "loading" }
  | { status: "ready"; refs: MediaRef[] }
  | { status: "error"; message: string };

function MediaPanel({ threadId, params }: PluginThreadPanelProps) {
  const sdk = useSdk();
  const messageSeq = panelMessageSeq(params);
  const [state, setState] = useState<PanelState>({ status: "loading" });

  useEffect(() => {
    if (messageSeq === null) return;
    let cancelled = false;
    setState({ status: "loading" });
    sdk.threads
      .message({ threadId, seq: messageSeq })
      .then((result) => {
        if (!cancelled) setState({ status: "ready", refs: extractMediaRefs(result.message) });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: "error", message: `Couldn't read this message: ${errorMessage(error)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [sdk, threadId, messageSeq]);

  if (messageSeq === null) {
    return (
      <InlineNotice tone="info">
        Open a message's actions and choose Play media to list its videos and audio here.
      </InlineNotice>
    );
  }
  if (state.status === "loading") return <InlineNotice tone="info">Looking for media in this message…</InlineNotice>;
  if (state.status === "error") return <InlineNotice tone="error">{state.message}</InlineNotice>;
  const items = state.refs
    .map((ref) => ({ ref, options: refOptions(ref) }))
    .filter((item): item is { ref: MediaRef; options: MediaOptions } => item.options !== null);
  if (items.length === 0) return <InlineNotice tone="info">{NO_MEDIA}.</InlineNotice>;
  return (
    <div className="flex flex-col gap-1" data-inline-media-panel="">
      <div className="text-xs text-muted-foreground">
        {items.length === 1 ? "1 media file" : `${items.length} media files`} in this message
      </div>
      {items.map(({ ref, options }) => (
        <MediaPlayer
          key={`${ref.source}:${ref.file}`}
          options={options}
          threadId={threadId}
          openWorkspaceFile={null}
          messageSeq={messageSeq}
        />
      ))}
    </div>
  );
}

function messageSeqOf(context: PluginMessageActionContext): number {
  const seq = context.message.experimental_messageSeq;
  return typeof seq === "number" ? seq : context.message.sourceSeqEnd;
}

async function playMediaAction(context: PluginMessageActionContext): Promise<void> {
  const seq = messageSeqOf(context);
  // With the SDK client from the bridge, decide up front; without it, the
  // panel reads the message itself.
  let refs: MediaRef[] | null = null;
  const sdk = bridge.sdk;
  if (sdk !== null) {
    try {
      const result = await sdk.threads.message({ threadId: context.threadId, seq });
      refs = extractMediaRefs(result.message);
    } catch {
      refs = null;
    }
  }
  if (refs === null && context.message.role === "assistant" && extractFromText(context.message.text).length === 0) {
    refs = [];
  }
  if (refs !== null && refs.length === 0) {
    toast(NO_MEDIA);
    return;
  }
  const opened = context.openPanel({ actionId: PANEL_ACTION_ID, title: "Media", params: { messageSeq: seq } });
  if (!opened) toast.error("bb couldn't open the Media panel here.");
}

// ---------------------------------------------------------------------------
// Route 3 (best effort): ▶ buttons after media file links.

const mounts = createMountStore();

/** Shared between the overlay bridge (React) and the content script (DOM). */
const bridge = (() => {
  let sdk: PluginBrowserBbSdk | null = null;
  let enabled = false;
  const listeners = new Set<() => void>();
  return {
    get sdk() {
      return sdk;
    },
    setSdk(next: PluginBrowserBbSdk | null) {
      sdk = next;
    },
    get enabled() {
      return enabled;
    },
    setEnabled(next: boolean) {
      if (enabled === next) return;
      enabled = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
})();

function LinkPlayer({ request }: { request: InlineMountRequest }) {
  const options = useMemo(() => {
    const parsed = parseMediaAttributes({ file: request.file }, request.kind);
    return parsed.ok ? parsed.value : null;
  }, [request.file, request.kind]);
  if (options === null) return null;
  return (
    <MediaPlayer options={options} threadId={request.threadId} openWorkspaceFile={null} messageSeq={request.messageSeq} />
  );
}

/**
 * Mounted once per window (experimental_appOverlay). Renders the link players
 * into the containers the content script inserted, through portals, so they
 * keep this plugin's React context. Also hands the SDK client to the message
 * action and switches the link decorator on and off with its setting.
 */
function InlineMediaBridge() {
  const sdk = useSdk();
  const { values } = useSettings();
  const decorate = values !== undefined && values.decorateLinks !== false;
  useEffect(() => {
    bridge.setSdk(sdk);
    return () => bridge.setSdk(null);
  }, [sdk]);
  useEffect(() => {
    bridge.setEnabled(decorate);
    return () => bridge.setEnabled(false);
  }, [decorate]);
  const list = useSyncExternalStore(mounts.subscribe, mounts.list, mounts.list);
  return <>{list.map((mount) => createPortal(<LinkPlayer request={mount.request} />, mount.container, String(mount.id)))}</>;
}

function mountLinkDecorator({ signal }: PluginContentScriptContext): () => void {
  let decorator: LinkDecorator | null = null;
  const stop = () => {
    decorator?.dispose();
    decorator = null;
    mounts.clear();
  };
  const sync = () => {
    try {
      if (!bridge.enabled || signal.aborted) {
        stop();
        return;
      }
      if (decorator !== null || typeof document === "undefined" || document.body === null) return;
      decorator = createLinkDecorator({
        root: document.body,
        document,
        signal,
        fallbackThreadId: () => threadIdFromLocation(window.location.pathname),
        open: (match, container) => {
          mounts.add(container, {
            threadId: match.threadId,
            file: match.path,
            name: match.name,
            kind: match.kind,
            messageSeq: match.messageSeq,
          });
        },
        close: (container) => mounts.removeContainer(container),
      });
    } catch {
      stop();
    }
  };
  const unsubscribe = bridge.subscribe(sync);
  sync();
  const dispose = () => {
    unsubscribe();
    stop();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}

export default definePluginApp((app) => {
  // Route 1: directives in agent replies.
  for (const id of ["video", "audio", "media"] as const) {
    app.slots.messageDirective({ id, component: directiveComponent(id) });
  }
  // Route 2: "Play media" on any message, listing its media in a side panel.
  app.slots.threadPanelAction({ id: PANEL_ACTION_ID, title: "Media", icon: "Play", component: MediaPanel });
  app.slots.messageAction({ id: "play-media", title: "Play media", icon: "Play", run: playMediaAction });
  // Route 3 (best effort): needs the experimental overlay slot as its React bridge.
  if (typeof app.slots.experimental_appOverlay === "function") {
    app.slots.experimental_appOverlay({ id: "inline-media-bridge", component: InlineMediaBridge });
    app.contentScripts.register({ id: "inline-media-links", mount: mountLinkDecorator });
  }
});
