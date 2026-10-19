// Inline Media — backend.
//
// Two RPCs:
// - `mediaUrl` turns an untrusted `file` into a short-lived bb preview URL the
//   browser can stream (bb's preview server handles range requests, so
//   seeking works and nothing is buffered here).
// - `reveal` shows the same file in Finder, on the bb server's own Mac.
//
// Both resolve the file the same way:
// - Only allowlisted media extensions are served.
// - Relative paths resolve against the thread's workspace or thread storage;
//   `..`, URLs and `~` are refused.
// - Absolute paths are allowed only (a) inside Composer Dropzone's drops
//   folder (setting `allowDropzoneFolder`), (b) inside the thread's own
//   workspace or thread storage (served as the relative path), or (c) when the
//   user attached exactly that file to a message in the thread, which the
//   server checks with bb's SDK (prompt history `localFile` host + path, and
//   the referenced message's attachments). Never from a protected location
//   (~/.ssh, ~/.claude*, bb's data folder except drops, keychains, ...).
// - No plugin HTTP routes and no network calls. The one child process is
//   `/usr/bin/open -R <file>` for Reveal in Finder, with an argument vector.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  attachedFilesFromMessage,
  attachedFilesFromPromptHistory,
  exposesProtectedLocation,
  isAttachedPath,
  isProtectedLocation,
  type AttachedFile,
  type ProtectedOptions,
} from "./lib/authorize.ts";
import type { MediaKind } from "./lib/media.ts";
import { checkRequestedPath, joinPreviewUrl } from "./lib/paths.ts";
import { createPreviewCache, previewCacheKey } from "./lib/preview-cache.ts";
import {
  dataDirFromDatabaseName,
  dropsDirFromDatabaseName,
  isStrictlyInside,
  planMediaRequest,
  relativeInside,
  resolveInsideRoot,
} from "./lib/roots.ts";

const PREVIEW_TTL_MS = 30 * 60 * 1000;
/** Prompt history entries checked for attachments. */
const HISTORY_LIMIT = 500;
const HISTORY_CACHE_MS = 15_000;

const liveTarget = z.union([
  z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }).strict(),
  z.object({ kind: z.literal("thread-storage"), threadId: z.string(), path: z.string() }).strict(),
  z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }).strict(),
]);

/** The message a request came from: its `experimental_messageSeq`. Lets the server check that message's attachments. */
const messageRef = z.object({ seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();

const fileRequest = {
  threadId: z.string().trim().min(1).max(256),
  path: z.string().max(2048),
  source: z.enum(["workspace", "thread-storage"]).default("workspace"),
  message: messageRef.optional(),
};

export const rpcContract = defineRpcContract({
  mediaUrl: {
    input: z
      .object({
        ...fileRequest,
        /** Skip the preview cache, e.g. after the browser saw an expired URL. */
        refresh: z.boolean().optional(),
      })
      .strict(),
    output: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("ok"),
          url: z.string(),
          name: z.string(),
          sizeBytes: z.number().nullable(),
          mediaKind: z.enum(["video", "audio"]),
          expiresAtMs: z.number(),
          /** Where the file lives, for bb's file preview panel. Null when unknown. */
          target: liveTarget.nullable(),
          /** True when `reveal` can show this file in Finder (a file on the bb server's own Mac). */
          canReveal: z.boolean(),
        })
        .strict(),
      z.object({ kind: z.literal("not-found"), name: z.string() }).strict(),
    ]),
  },
  reveal: {
    input: z.object(fileRequest).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

type LiveTarget = z.infer<typeof liveTarget>;

interface ResolvedRoot {
  rootPath: string;
  hostId: string | undefined;
  /** Builds the live-file target for bb's preview panel from a root-relative path. */
  target: (relativePath: string) => LiveTarget | null;
}

/** A request resolved to one file, or to "not found". */
type Resolution =
  | { kind: "not-found"; name: string }
  | {
      kind: "file";
      /** Host for createPreview; undefined lets bb pick its own machine. */
      hostId: string | undefined;
      /** Folder the preview is created for, and the file name inside it. */
      directory: string;
      fileName: string;
      /** The file on the bb server's machine, when it is local (else null). */
      localPath: string | null;
      sizeBytes: number | null;
      mediaKind: MediaKind;
      target: LiveTarget | null;
    };

type FileRequest = {
  threadId: string;
  path: string;
  source: "workspace" | "thread-storage";
  message?: { seq: number } | undefined;
};

/** Seams for tests. */
export interface InlineMediaServerOptions {
  /** The bb server user's home folder (default `os.homedir()`). */
  home?: string;
  /** Default `process.platform`; Reveal in Finder needs "darwin". */
  platform?: NodeJS.Platform;
  /** Shows a file in Finder (default: `/usr/bin/open -R <file>`). */
  revealFile?: (absolutePath: string) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

const execFileAsync = promisify(execFile);

async function openRevealInFinder(absolutePath: string): Promise<void> {
  // An argument vector, no shell: the path can't be interpreted as anything else.
  await execFileAsync("/usr/bin/open", ["-R", absolutePath], { timeout: 10_000 });
}

const ABSOLUTE_REFUSED =
  '"file" must be relative to the workspace. Absolute paths are allowed only for Composer Dropzone drops, files inside this thread\'s workspace, and files attached to a message in this thread.';

export async function createInlineMediaServer(bb: BbPluginApi, options: InlineMediaServerOptions = {}): Promise<void> {
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const revealFile = options.revealFile ?? openRevealInFinder;

  const settings = bb.settings.define({
    maxInlineHeight: {
      type: "number",
      label: "Largest inline video height (px)",
      description: "Videos taller than this are scaled down to fit. Open in the side panel to see them bigger.",
      default: 420,
      experimental_schema: z.number().int().min(120).max(2000),
    },
    allowDropzoneFolder: {
      type: "boolean",
      label: "Play files from Composer Dropzone's drops folder",
      description:
        "Large files dropped with the Composer Dropzone plugin are saved outside the workspace. Allow agents to show them inline by their absolute path.",
      default: true,
    },
    decorateLinks: {
      type: "boolean",
      label: "Play buttons on media file links",
      description:
        "Adds a small play button after links to video and audio files in messages. Best effort: if bb changes how it draws links, the buttons simply stop appearing. The Play media message action always works.",
      default: true,
    },
  });

  // bb keeps this plugin's database at <dataDir>/plugins/<id>/; Composer
  // Dropzone keeps its drops beside its own, at <dataDir>/plugins/composer-dropzone/drops.
  let dropsDir: string | null = null;
  let dataDir: string | null = null;
  try {
    const databaseName = bb.storage.database().name;
    dropsDir = dropsDirFromDatabaseName(databaseName);
    dataDir = dataDirFromDatabaseName(databaseName);
  } catch (error) {
    bb.log.warn(`drops folder unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const previews = createPreviewCache();
  const historyCache = new Map<string, { at: number; files: AttachedFile[] }>();

  function protectedOptions(allowDrops: boolean): ProtectedOptions {
    return { home, dataDir, dropsDir: allowDrops ? dropsDir : null };
  }

  async function primaryHostId(): Promise<string | null> {
    try {
      return (await bb.sdk.system.config()).primaryHostId ?? null;
    } catch {
      return null;
    }
  }

  async function workspaceRoot(threadId: string): Promise<ResolvedRoot> {
    const thread: unknown = await bb.sdk.threads.get({ threadId, include: "environment" });
    const environment = isRecord(thread) ? thread.environment : undefined;
    if (!isRecord(environment)) {
      throw new Error("This thread has no workspace yet, so there is nothing to play from it.");
    }
    const rootPath = typeof environment.path === "string" && environment.path.length > 0 ? environment.path : null;
    if (rootPath === null) throw new Error("This thread's workspace has no folder on disk yet.");
    const hostId = typeof environment.hostId === "string" ? environment.hostId : undefined;
    const environmentId = typeof environment.id === "string" ? environment.id : null;
    return {
      rootPath,
      hostId,
      target: (relativePath) =>
        environmentId === null ? null : { kind: "workspace", environmentId, path: relativePath },
    };
  }

  async function threadStorageRoot(threadId: string): Promise<ResolvedRoot> {
    const location = await bb.sdk.threads.storageLocation({ threadId });
    return {
      rootPath: location.storageRootPath,
      hostId: location.hostId,
      target: (relativePath) => ({ kind: "thread-storage", threadId, path: relativePath }),
    };
  }

  /** Files attached by absolute path in this thread (cached briefly: a message with ten clips asks ten times). */
  async function attachedFiles(threadId: string, message: { seq: number } | undefined): Promise<AttachedFile[]> {
    const files: AttachedFile[] = [];
    const cached = historyCache.get(threadId);
    if (cached !== undefined && Date.now() - cached.at < HISTORY_CACHE_MS) {
      files.push(...cached.files);
    } else {
      try {
        const history: unknown = await bb.sdk.threads.promptHistory({ threadId, limit: String(HISTORY_LIMIT) });
        const fromHistory = attachedFilesFromPromptHistory(history);
        historyCache.set(threadId, { at: Date.now(), files: fromHistory });
        if (historyCache.size > 64) historyCache.delete(historyCache.keys().next().value!);
        files.push(...fromHistory);
      } catch (error) {
        bb.log.warn(`prompt history unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (message !== undefined) {
      try {
        const result: unknown = await bb.sdk.threads.message({ threadId, seq: message.seq });
        const found = isRecord(result) ? result.message : undefined;
        // The message must belong to this thread.
        if (isRecord(found) && found.threadId === threadId) files.push(...attachedFilesFromMessage(found));
      } catch (error) {
        bb.log.warn(`message ${message.seq} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return files;
  }

  /**
   * On this machine only: follow symlinks and make sure the real file is still
   * inside the real root, and read its size. Returns null when the file system
   * isn't local (a remote host), so the URL is returned without the extra check.
   */
  async function localCheck(
    rootPath: string,
    filePath: string,
  ): Promise<{ kind: "ok"; sizeBytes: number } | { kind: "not-found" } | null> {
    try {
      const [realRoot, realFile] = await Promise.all([fs.realpath(rootPath), fs.realpath(filePath)]);
      if (!isStrictlyInside(realRoot, realFile)) {
        throw new Error("This file links to a location outside the workspace and is not served.");
      }
      const stat = await fs.stat(realFile);
      if (!stat.isFile()) return { kind: "not-found" };
      return { kind: "ok", sizeBytes: stat.size };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "not-found" };
      if (code !== null) return null;
      throw error;
    }
  }

  function refuseExposingPreview(directory: string, allowDrops: boolean): void {
    if (exposesProtectedLocation(directory, protectedOptions(allowDrops))) {
      throw new Error(
        "This file sits in a folder that also holds private data (such as your home folder), so it isn't served. Move it into a subfolder.",
      );
    }
  }

  async function resolveRelative(
    threadId: string,
    source: "workspace" | "thread-storage",
    relativePath: string,
    mediaKind: MediaKind,
    primary: string | null,
    allowDrops: boolean,
  ): Promise<Resolution> {
    const fileName = relativePath.split("/").pop() ?? relativePath;
    const root = source === "thread-storage" ? await threadStorageRoot(threadId) : await workspaceRoot(threadId);
    const filePath = resolveInsideRoot(root.rootPath, relativePath);
    if (filePath === null) throw new Error('"file" must stay inside the workspace.');
    const directory = path.dirname(filePath);

    let sizeBytes: number | null = null;
    const isLocal = root.hostId === undefined || (primary !== null && root.hostId === primary);
    if (isLocal) {
      const checked = await localCheck(root.rootPath, filePath);
      if (checked?.kind === "not-found") return { kind: "not-found", name: fileName };
      if (checked?.kind === "ok") sizeBytes = checked.sizeBytes;
      refuseExposingPreview(directory, allowDrops);
    }
    return {
      kind: "file",
      hostId: root.hostId,
      directory,
      fileName,
      localPath: isLocal ? filePath : null,
      sizeBytes,
      mediaKind,
      target: root.target(relativePath),
    };
  }

  /** Map an absolute path inside the workspace or thread storage to that root, or null. */
  async function mapIntoThreadRoots(
    threadId: string,
    absolutePath: string,
  ): Promise<{ source: "workspace" | "thread-storage"; relativePath: string } | null> {
    for (const source of ["workspace", "thread-storage"] as const) {
      let root: ResolvedRoot;
      try {
        root = source === "workspace" ? await workspaceRoot(threadId) : await threadStorageRoot(threadId);
      } catch {
        continue;
      }
      if (isStrictlyInside(root.rootPath, absolutePath)) {
        const relativePath = relativeInside(root.rootPath, absolutePath);
        const check = checkRequestedPath(relativePath);
        if (check.ok && check.kind === "relative") return { source, relativePath: check.path };
      }
    }
    return null;
  }

  async function resolveAttached(
    request: FileRequest,
    absolutePath: string,
    mediaKind: MediaKind,
    primary: string | null,
    allowDrops: boolean,
  ): Promise<Resolution> {
    const fileName = path.basename(absolutePath);
    if (primary === null) throw new Error(ABSOLUTE_REFUSED);
    const attached = await attachedFiles(request.threadId, request.message);
    if (!isAttachedPath(absolutePath, attached, primary, primary)) throw new Error(ABSOLUTE_REFUSED);
    const guard = protectedOptions(allowDrops);
    if (isProtectedLocation(absolutePath, guard)) {
      throw new Error("This file is in a protected location (keys, app data or bb's own folder) and is not served.");
    }
    let sizeBytes: number;
    try {
      const realFile = await fs.realpath(absolutePath);
      if (isProtectedLocation(realFile, guard)) {
        throw new Error("This file links into a protected location and is not served.");
      }
      const stat = await fs.stat(realFile);
      if (!stat.isFile()) return { kind: "not-found", name: fileName };
      sizeBytes = stat.size;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "not-found", name: fileName };
      throw error;
    }
    const directory = path.dirname(absolutePath);
    refuseExposingPreview(directory, allowDrops);
    return {
      kind: "file",
      hostId: primary,
      directory,
      fileName,
      localPath: absolutePath,
      sizeBytes,
      mediaKind,
      target: { kind: "host", hostId: primary, path: absolutePath },
    };
  }

  async function resolve(request: FileRequest): Promise<Resolution> {
    const { allowDropzoneFolder } = await settings.get();
    const plan = planMediaRequest({
      path: request.path,
      source: request.source,
      dropsDir,
      allowDropzoneFolder,
      allowAbsolute: true,
    });
    if (!plan.ok) throw new Error(plan.message);
    const primary = await primaryHostId();

    if (plan.root === "drops") {
      // The drops folder is on the machine running bb's server.
      const checked = await localCheck(dropsDir!, plan.absolutePath!);
      if (checked?.kind === "not-found") return { kind: "not-found", name: plan.fileName };
      const hostId = primary ?? undefined;
      return {
        kind: "file",
        hostId,
        directory: plan.directory,
        fileName: plan.fileName,
        localPath: plan.absolutePath,
        sizeBytes: checked?.kind === "ok" ? checked.sizeBytes : null,
        mediaKind: plan.mediaKind,
        target: hostId === undefined ? null : { kind: "host", hostId, path: plan.absolutePath! },
      };
    }

    if (plan.root === "absolute") {
      const mapped = await mapIntoThreadRoots(request.threadId, plan.absolutePath!);
      if (mapped !== null) {
        return resolveRelative(request.threadId, mapped.source, mapped.relativePath, plan.mediaKind, primary, allowDropzoneFolder);
      }
      return resolveAttached(request, plan.absolutePath!, plan.mediaKind, primary, allowDropzoneFolder);
    }

    return resolveRelative(request.threadId, plan.root, plan.relativePath!, plan.mediaKind, primary, allowDropzoneFolder);
  }

  async function previewUrl(
    hostId: string | undefined,
    directory: string,
    fileName: string,
    refresh: boolean,
  ): Promise<{ url: string; expiresAtMs: number }> {
    const entry = await previews.obtain(
      previewCacheKey(hostId, directory),
      () =>
        bb.sdk.files.createPreview({
          ...(hostId === undefined ? {} : { hostId }),
          rootPath: directory,
          ttlMs: PREVIEW_TTL_MS,
        }),
      refresh,
    );
    return { url: joinPreviewUrl(entry.baseUrl, fileName), expiresAtMs: entry.expiresAtMs };
  }

  bb.rpc.register(rpcContract, {
    mediaUrl: async ({ refresh, ...request }) => {
      const resolved = await resolve(request);
      if (resolved.kind === "not-found") return { kind: "not-found" as const, name: resolved.name };
      const { url, expiresAtMs } = await previewUrl(resolved.hostId, resolved.directory, resolved.fileName, refresh === true);
      return {
        kind: "ok" as const,
        url,
        name: resolved.fileName,
        sizeBytes: resolved.sizeBytes,
        mediaKind: resolved.mediaKind,
        expiresAtMs,
        target: resolved.target,
        canReveal: platform === "darwin" && resolved.localPath !== null,
      };
    },
    reveal: async (request) => {
      const resolved = await resolve(request);
      if (resolved.kind === "not-found") throw new Error(`File not found: ${resolved.name}`);
      if (platform !== "darwin" || resolved.localPath === null) {
        throw new Error("Reveal in Finder works only for files on the Mac that runs bb.");
      }
      await revealFile(resolved.localPath);
      return { ok: true as const };
    },
  });

  bb.onDispose(() => {
    previews.clear();
    historyCache.clear();
  });
  bb.log.info("loaded");
}

export default async function plugin(bb: BbPluginApi) {
  await createInlineMediaServer(bb);
}
