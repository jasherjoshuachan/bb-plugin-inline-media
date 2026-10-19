// Inline Media — backend.
//
// One RPC, `mediaUrl`, turns an untrusted `file` from a directive into a
// short-lived bb preview URL the browser can stream (bb's preview server
// handles range requests, so seeking works and nothing is buffered here).
//
// - Only allowlisted media extensions are served.
// - Relative paths resolve against the thread's workspace or thread storage;
//   `..`, URLs and `~` are refused.
// - The single absolute root is Composer Dropzone's drops folder on this
//   machine, behind the `allowDropzoneFolder` setting.
// - No plugin HTTP routes, no network calls, no child processes.
import { promises as fs } from "node:fs";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { joinPreviewUrl } from "./lib/paths.ts";
import { createPreviewCache, previewCacheKey } from "./lib/preview-cache.ts";
import { dropsDirFromDatabaseName, isStrictlyInside, planMediaRequest, resolveInsideRoot } from "./lib/roots.ts";

const PREVIEW_TTL_MS = 30 * 60 * 1000;

const liveTarget = z.union([
  z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }).strict(),
  z.object({ kind: z.literal("thread-storage"), threadId: z.string(), path: z.string() }).strict(),
  z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }).strict(),
]);

export const rpcContract = defineRpcContract({
  mediaUrl: {
    input: z
      .object({
        threadId: z.string().trim().min(1).max(256),
        path: z.string().max(2048),
        source: z.enum(["workspace", "thread-storage"]).default("workspace"),
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
        })
        .strict(),
      z.object({ kind: z.literal("not-found"), name: z.string() }).strict(),
    ]),
  },
});

type LiveTarget = z.infer<typeof liveTarget>;

interface ResolvedRoot {
  rootPath: string;
  hostId: string | undefined;
  /** Builds the live-file target for bb's preview panel from a root-relative path. */
  target: (relativePath: string) => LiveTarget | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

export default async function plugin(bb: BbPluginApi) {
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
      label: "Play buttons on media file links (coming in v0.2)",
      description: "Reserved for the link play buttons planned for v0.2. Has no effect in v0.1.",
      default: true,
    },
  });

  // bb keeps this plugin's database at <dataDir>/plugins/<id>/; Composer
  // Dropzone keeps its drops beside its own, at <dataDir>/plugins/composer-dropzone/drops.
  let dropsDir: string | null = null;
  try {
    dropsDir = dropsDirFromDatabaseName(bb.storage.database().name);
  } catch (error) {
    bb.log.warn(`drops folder unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const previews = createPreviewCache();

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
    mediaUrl: async ({ threadId, path: requested, source, refresh }) => {
      const { allowDropzoneFolder } = await settings.get();
      const plan = planMediaRequest({ path: requested, source, dropsDir, allowDropzoneFolder });
      if (!plan.ok) throw new Error(plan.message);
      const primary = await primaryHostId();

      if (plan.root === "drops") {
        // The drops folder is on the machine running bb's server.
        const checked = await localCheck(dropsDir!, plan.absolutePath!);
        if (checked?.kind === "not-found") return { kind: "not-found" as const, name: plan.fileName };
        const hostId = primary ?? undefined;
        const { url, expiresAtMs } = await previewUrl(hostId, plan.directory, plan.fileName, refresh === true);
        return {
          kind: "ok" as const,
          url,
          name: plan.fileName,
          sizeBytes: checked?.kind === "ok" ? checked.sizeBytes : null,
          mediaKind: plan.mediaKind,
          expiresAtMs,
          target: hostId === undefined ? null : { kind: "host" as const, hostId, path: plan.absolutePath! },
        };
      }

      const root = plan.root === "thread-storage" ? await threadStorageRoot(threadId) : await workspaceRoot(threadId);
      const filePath = resolveInsideRoot(root.rootPath, plan.relativePath!);
      if (filePath === null) throw new Error('"file" must stay inside the workspace.');
      const directory = path.dirname(filePath);

      let sizeBytes: number | null = null;
      const isLocal = root.hostId === undefined || (primary !== null && root.hostId === primary);
      if (isLocal) {
        const checked = await localCheck(root.rootPath, filePath);
        if (checked?.kind === "not-found") return { kind: "not-found" as const, name: plan.fileName };
        if (checked?.kind === "ok") sizeBytes = checked.sizeBytes;
      }

      const { url, expiresAtMs } = await previewUrl(root.hostId, directory, plan.fileName, refresh === true);
      return {
        kind: "ok" as const,
        url,
        name: plan.fileName,
        sizeBytes,
        mediaKind: plan.mediaKind,
        expiresAtMs,
        target: root.target(plan.relativePath!),
      };
    },
  });

  bb.onDispose(() => {
    previews.clear();
  });
  bb.log.info("loaded");
}
