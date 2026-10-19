// Best-effort ▶ buttons after media file links in rendered messages.
//
// bb has no SDK slot for file links, so this reads the rendered DOM. It
// relies only on these signals, recorded from bb 0.46 (see README,
// "Play buttons on links"):
//
//   [data-timeline-row-id]   one timeline row; its value starts with the thread
//                            id ("thr_x:assistant:…", "thr_x:user-seed:<seq>")
//   [data-markdown-preview]  the rendered message body inside that row
//   a[href^="file:"]         a link to a local file; bb rewrites workspace
//                            links to file:///<absolute path>
//
// If none of them match (bb changed its markup), nothing is decorated and
// nothing breaks. The decorator never throws, never edits bb's nodes (it only
// inserts its own sibling elements), and removes everything it added when it
// is disposed.
import { fileUrlToPath } from "./extract.ts";
import { baseName, mediaKindForPath, type MediaKind } from "./media.ts";
import { checkRequestedPath } from "./paths.ts";

export const LINK_SELECTORS = Object.freeze({
  row: "[data-timeline-row-id]",
  body: "[data-markdown-preview]",
  link: 'a[href^="file:"]',
});

/** Marks every element this plugin inserts, so it is never mistaken for bb's own. */
export const OWNED_ATTRIBUTE = "data-inline-media-owned";

const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface MediaLinkMatch {
  anchor: HTMLAnchorElement;
  /** Absolute path from the link's file: URL. */
  path: string;
  name: string;
  kind: MediaKind;
  threadId: string;
  /** For user messages (row id "…:user-seed:<seq>"); null for agent replies. */
  messageSeq: number | null;
}

/** "thr_x:assistant:kind:…" → "thr_x". */
export function threadIdFromRowId(rowId: string | null): string | null {
  if (rowId === null) return null;
  const id = rowId.split(":")[0] ?? "";
  return THREAD_ID.test(id) ? id : null;
}

/** "thr_x:user-seed:42" → 42; null for any other row. */
export function messageSeqFromRowId(rowId: string | null): number | null {
  if (rowId === null) return null;
  const match = /:user-seed:(\d{1,15})$/.exec(rowId);
  return match === null ? null : Number(match[1]);
}

/** "/projects/p/threads/thr_x" → "thr_x". */
export function threadIdFromLocation(pathname: string): string | null {
  const match = /\/threads\/([^/?#]+)/.exec(pathname);
  return match !== null && THREAD_ID.test(match[1]!) ? match[1]! : null;
}

/** Every media file link inside rendered message bodies under `root`. Never throws. */
export function findMediaLinks(root: ParentNode, fallbackThreadId: string | null = null): MediaLinkMatch[] {
  const out: MediaLinkMatch[] = [];
  let anchors: Element[];
  try {
    anchors = Array.from(root.querySelectorAll(`${LINK_SELECTORS.row} ${LINK_SELECTORS.body} ${LINK_SELECTORS.link}`));
  } catch {
    return out;
  }
  for (const element of anchors) {
    try {
      if (element.closest(`[${OWNED_ATTRIBUTE}]`) !== null) continue;
      const anchor = element as HTMLAnchorElement;
      const filePath = fileUrlToPath(anchor.getAttribute("href") ?? "");
      if (filePath === null) continue;
      const check = checkRequestedPath(filePath);
      if (!check.ok || check.kind !== "absolute") continue;
      const kind = mediaKindForPath(check.path);
      if (kind === null) continue;
      const rowId = anchor.closest(LINK_SELECTORS.row)?.getAttribute("data-timeline-row-id") ?? null;
      const threadId = threadIdFromRowId(rowId) ?? fallbackThreadId;
      if (threadId === null) continue;
      out.push({ anchor, path: check.path, name: baseName(check.path), kind, threadId, messageSeq: messageSeqFromRowId(rowId) });
    } catch {
      // Skip anything unexpected.
    }
  }
  return out;
}

/** Where an expanded player goes: after the link's paragraph or list item, so it sits under the link. */
export function playerAnchorFor(anchor: Element): Element {
  const body = anchor.closest(LINK_SELECTORS.body);
  const block = anchor.closest("p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6");
  return block !== null && body !== null && body.contains(block) && block !== body ? block : anchor;
}

export interface DecoratorCallbacks {
  /** Mount a player for `match` into `container` (an element this decorator owns). */
  open(match: MediaLinkMatch, container: HTMLElement): void;
  /** Unmount the player in `container`. */
  close(container: HTMLElement): void;
}

export interface LinkDecoratorOptions extends DecoratorCallbacks {
  root: ParentNode & Node;
  document: Document;
  signal: AbortSignal;
  /** Thread id when a row doesn't carry one (from the URL). */
  fallbackThreadId?: () => string | null;
  /** Defaults to the global MutationObserver; absent → scan only on demand. */
  MutationObserver?: typeof MutationObserver;
  /** Debounce between DOM changes and a rescan (default 120 ms). */
  delayMs?: number;
}

export interface LinkDecorator {
  /** Decorate new links and remove buttons whose link is gone. */
  scan(): void;
  /** Number of ▶ buttons currently inserted. */
  readonly count: number;
  dispose(): void;
}

interface Decoration {
  anchor: HTMLAnchorElement;
  button: HTMLButtonElement;
  container: HTMLElement | null;
}

const PLAY_PATH = "M8 5.5v13a.5.5 0 0 0 .77.42l10-6.5a.5.5 0 0 0 0-.84l-10-6.5A.5.5 0 0 0 8 5.5z";
const CLOSE_PATH = "M7 7l10 10M17 7L7 17";

function setIcon(doc: Document, button: HTMLButtonElement, open: boolean): void {
  const ns = "http://www.w3.org/2000/svg";
  while (button.firstChild) button.firstChild.remove();
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  const shape = doc.createElementNS(ns, "path");
  shape.setAttribute("d", open ? CLOSE_PATH : PLAY_PATH);
  if (open) {
    shape.setAttribute("stroke", "currentColor");
    shape.setAttribute("stroke-width", "2");
    shape.setAttribute("stroke-linecap", "round");
    shape.setAttribute("fill", "none");
  } else {
    shape.setAttribute("fill", "currentColor");
  }
  svg.appendChild(shape);
  button.appendChild(svg);
}

/**
 * Watch `root` and keep a ▶ button after every media file link. Clicking it
 * inserts a container under the link and asks `open` to mount a player there;
 * clicking again closes it. Everything is undone on `dispose()` or when
 * `signal` aborts.
 */
export function createLinkDecorator(options: LinkDecoratorOptions): LinkDecorator {
  const doc = options.document;
  const decorations = new Map<HTMLAnchorElement, Decoration>();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;

  function safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Never let a DOM surprise escape into bb.
    }
  }

  function closePlayer(decoration: Decoration): void {
    const container = decoration.container;
    decoration.container = null;
    if (container !== null) {
      safe(() => options.close(container));
      safe(() => container.remove());
    }
    safe(() => {
      decoration.button.setAttribute("aria-expanded", "false");
      decoration.button.setAttribute("aria-label", `Play ${decoration.button.dataset.name ?? "media"} here`);
      decoration.button.title = "Play here";
      setIcon(doc, decoration.button, false);
    });
  }

  function remove(decoration: Decoration): void {
    closePlayer(decoration);
    safe(() => decoration.button.remove());
    decorations.delete(decoration.anchor);
  }

  function openPlayer(decoration: Decoration, match: MediaLinkMatch): void {
    const container = doc.createElement("div");
    container.setAttribute(OWNED_ATTRIBUTE, "player");
    container.style.margin = "4px 0 8px";
    playerAnchorFor(decoration.anchor).after(container);
    decoration.container = container;
    decoration.button.setAttribute("aria-expanded", "true");
    decoration.button.setAttribute("aria-label", `Close the player for ${match.name}`);
    decoration.button.title = "Close player";
    setIcon(doc, decoration.button, true);
    safe(() => options.open(match, container));
  }

  function decorate(match: MediaLinkMatch): void {
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute(OWNED_ATTRIBUTE, "toggle");
    button.dataset.name = match.name;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", `Play ${match.name} here`);
    button.title = "Play here";
    // Inline styles: this button lives outside the plugin's React tree and must not depend on bb's class names.
    Object.assign(button.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: "18px",
      height: "18px",
      marginLeft: "4px",
      padding: "0",
      border: "1px solid currentColor",
      borderRadius: "9999px",
      background: "transparent",
      color: "inherit",
      opacity: "0.7",
      cursor: "pointer",
      verticalAlign: "-0.2em",
    } satisfies Partial<CSSStyleDeclaration>);
    setIcon(doc, button, false);
    const decoration: Decoration = { anchor: match.anchor, button, container: null };
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      safe(() => {
        if (decoration.container !== null) closePlayer(decoration);
        else openPlayer(decoration, match);
      });
    });
    match.anchor.after(button);
    decorations.set(match.anchor, decoration);
  }

  function scan(): void {
    if (disposed) return;
    safe(() => {
      // Drop buttons whose link bb removed or re-rendered.
      for (const decoration of [...decorations.values()]) {
        const stale =
          !decoration.anchor.isConnected ||
          !decoration.button.isConnected ||
          decoration.anchor.nextSibling !== decoration.button;
        if (stale) remove(decoration);
      }
      const fallback = options.fallbackThreadId?.() ?? null;
      for (const match of findMediaLinks(options.root, fallback)) {
        if (!decorations.has(match.anchor)) safe(() => decorate(match));
      }
    });
  }

  function schedule(): void {
    if (disposed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, options.delayMs ?? 120);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    safe(() => observer?.disconnect());
    observer = null;
    for (const decoration of [...decorations.values()]) remove(decoration);
    options.signal.removeEventListener("abort", dispose);
  }

  if (options.signal.aborted) {
    disposed = true;
  } else {
    options.signal.addEventListener("abort", dispose, { once: true });
    const Observer = options.MutationObserver ?? (typeof MutationObserver === "function" ? MutationObserver : undefined);
    if (Observer !== undefined) {
      safe(() => {
        observer = new Observer((records) => {
          // Ignore changes that are only our own elements coming and going.
          const foreign = records.some((record) => {
            const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
            if (nodes.length === 0) return true;
            return nodes.some((node) => node.nodeType !== 1 || !(node as Element).hasAttribute(OWNED_ATTRIBUTE));
          });
          if (foreign) schedule();
        });
        observer.observe(options.root, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
      });
    }
    scan();
  }

  return {
    scan,
    get count() {
      return decorations.size;
    },
    dispose,
  };
}
