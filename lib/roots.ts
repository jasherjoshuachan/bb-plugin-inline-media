// Server-side decisions about which root a requested media file belongs to.
//
// Pure functions over strings (node:path only, no file system), so every
// security decision is unit tested. server.ts does the I/O.
import path from "node:path";
import { checkRequestedPath, splitRelative, type PathCheck } from "./paths.ts";
import type { MediaKind, MediaSource } from "./media.ts";

export type { MediaSource };

/** The folder Composer Dropzone saves large drops in, derived from this plugin's database path. */
export function dropsDirFromDatabaseName(databaseName: string): string {
  // bb keeps each plugin's database at <dataDir>/plugins/<pluginId>/<file>.
  const pluginsDir = path.dirname(path.dirname(databaseName));
  return path.join(pluginsDir, "composer-dropzone", "drops");
}

/** True when `candidate` is strictly inside `directory` (not the directory itself). */
export function isStrictlyInside(directory: string, candidate: string): boolean {
  const root = path.resolve(directory);
  const target = path.resolve(candidate);
  const rel = path.relative(root, target);
  if (rel === "" || path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

/** Resolve a normalized relative path under a root, refusing anything that escapes it. */
export function resolveInsideRoot(rootPath: string, relativePath: string): string | null {
  const target = path.resolve(rootPath, relativePath);
  return isStrictlyInside(rootPath, target) ? target : null;
}

export type MediaPlan =
  | {
      ok: true;
      /** Which root the file is served from. */
      root: MediaSource | "drops";
      /** For workspace and thread-storage: the path relative to that root. */
      relativePath: string | null;
      /** For drops: the absolute file path. */
      absolutePath: string | null;
      /** Directory to create the preview for: relative to the root, or absolute for drops. */
      directory: string;
      fileName: string;
      mediaKind: MediaKind;
    }
  | { ok: false; message: string };

export interface PlanInput {
  path: unknown;
  source: MediaSource;
  dropsDir: string | null;
  allowDropzoneFolder: boolean;
}

/**
 * Decide how a request is served, or refuse it. Relative paths go to the
 * requested source. An absolute path is allowed only when it sits inside
 * Composer Dropzone's drops folder and the setting allows it.
 */
export function planMediaRequest(input: PlanInput): MediaPlan {
  const check: PathCheck = checkRequestedPath(input.path);
  if (!check.ok) return { ok: false, message: check.message };

  if (check.kind === "relative") {
    const { directory, fileName } = splitRelative(check.path);
    return {
      ok: true,
      root: input.source,
      relativePath: check.path,
      absolutePath: null,
      directory,
      fileName,
      mediaKind: check.mediaKind,
    };
  }

  // Absolute: only Composer Dropzone's drops folder, on this machine.
  if (!input.allowDropzoneFolder || input.dropsDir === null) {
    return { ok: false, message: '"file" must be relative to the workspace, not an absolute path.' };
  }
  if (path.sep === "/" && (check.path.includes("\\") || /^[a-zA-Z]:/.test(check.path))) {
    return { ok: false, message: '"file" must be relative to the workspace, not an absolute path.' };
  }
  const absolutePath = path.resolve(check.path);
  if (!isStrictlyInside(input.dropsDir, absolutePath)) {
    return {
      ok: false,
      message: '"file" must be relative to the workspace. The only absolute paths allowed are Composer Dropzone drops.',
    };
  }
  // Never serve the in-progress upload folder.
  const rel = path.relative(path.resolve(input.dropsDir), absolutePath);
  if (rel.split(path.sep).some((segment) => segment.startsWith("."))) {
    return { ok: false, message: "Hidden files in the drops folder are not served." };
  }
  return {
    ok: true,
    root: "drops",
    relativePath: null,
    absolutePath,
    directory: path.dirname(absolutePath),
    fileName: path.basename(absolutePath),
    mediaKind: check.mediaKind,
  };
}
