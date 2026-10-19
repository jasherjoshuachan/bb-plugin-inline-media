// Validation of the untrusted `file` value from a directive or an RPC call.
//
// Pure string logic with no Node imports, so the player can reject a bad
// directive before it calls the server, and the server runs the very same
// checks again before touching any file API. Root confinement against real
// directories lives in roots.ts (server only).
import { allowedExtensionsText, mediaKindForPath, type MediaKind } from "./media.ts";

export const MAX_PATH_LENGTH = 1024;

export type PathErrorCode =
  | "not-string"
  | "empty"
  | "too-long"
  | "control-chars"
  | "remote-url"
  | "scheme"
  | "home"
  | "traversal"
  | "not-media";

export type PathCheck =
  | {
      ok: true;
      /** `relative` is normalized to forward slashes; `absolute` is returned as given. */
      kind: "relative" | "absolute";
      path: string;
      mediaKind: MediaKind;
    }
  | { ok: false; code: PathErrorCode; message: string };

function fail(code: PathErrorCode, message: string): PathCheck {
  return { ok: false, code, message };
}

/** True for `/x`, `\x`, `\\server\share` and Windows drive paths like `C:\x` or `C:/x`. */
export function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(value);
}

/**
 * A segment that is, or decodes to, a parent reference. Percent-encoded forms
 * are refused too: the path is used literally, but refusing them means no
 * layer that decodes once more can ever see `..`.
 */
function isTraversalSegment(segment: string): boolean {
  if (segment === "..") return true;
  if (!segment.includes("%")) return false;
  let decoded = segment;
  // Decode up to three times to catch double and triple encoding.
  for (let i = 0; i < 3; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break; // not decodable any further, so no layer can turn it into ".."
    }
    if (next === decoded) break;
    decoded = next;
  }
  return decoded === ".." || /[\\/]/.test(decoded) || decoded.split(/[\\/]/).includes("..");
}

/**
 * Check a requested media path. Refuses empty or oversized values, control
 * characters, URLs and other schemes (`https:`, `file:`, `data:`), `~` paths,
 * any `..` segment (with either separator, also percent-encoded), and files
 * whose extension is not on the media allowlist (case-insensitive).
 *
 * Absolute paths pass this check as `kind: "absolute"`; whether one is
 * allowed (only inside Composer Dropzone's drops folder) is the server's call.
 */
export function checkRequestedPath(raw: unknown): PathCheck {
  if (typeof raw !== "string") return fail("not-string", '"file" must be a string.');
  const value = raw.trim();
  if (value.length === 0) return fail("empty", '"file" is required, e.g. file="out/demo.mp4".');
  if (value.length > MAX_PATH_LENGTH) {
    return fail("too-long", `"file" is longer than ${MAX_PATH_LENGTH} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return fail("control-chars", '"file" contains control characters.');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) {
    if (/^(https?|ftp|wss?):/i.test(value)) {
      return fail("remote-url", "Remote URLs are not played. Save the file in the workspace and point at it.");
    }
    return fail("scheme", '"file" must be a path, not a URL.');
  }
  if (value.startsWith("//") && !value.startsWith("///")) {
    return fail("remote-url", "Remote URLs are not played. Save the file in the workspace and point at it.");
  }
  if (value.startsWith("~")) {
    return fail("home", '"file" must be relative to the workspace, not start with "~".');
  }
  const segments = value.split(/[\\/]/);
  if (segments.some(isTraversalSegment)) {
    return fail("traversal", '"file" must not contain ".." segments.');
  }

  let kind: "relative" | "absolute";
  let normalized: string;
  if (isAbsoluteLike(value)) {
    kind = "absolute";
    normalized = value;
  } else {
    kind = "relative";
    normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
    if (normalized.length === 0) return fail("empty", '"file" must name a file.');
  }

  if (/[\\/]$/.test(value)) return fail("not-media", '"file" must name a file, not a folder.');
  const mediaKind = mediaKindForPath(normalized);
  if (mediaKind === null) {
    return fail("not-media", `"file" must be a media file (${allowedExtensionsText()}).`);
  }
  return { ok: true, kind, path: normalized, mediaKind };
}

/** Split a normalized relative path into its directory ("" for top level) and file name. */
export function splitRelative(relativePath: string): { directory: string; fileName: string } {
  const slash = relativePath.lastIndexOf("/");
  if (slash === -1) return { directory: "", fileName: relativePath };
  return { directory: relativePath.slice(0, slash), fileName: relativePath.slice(slash + 1) };
}

/** Append one file name to a preview base URL, encoded as a single path segment. */
export function joinPreviewUrl(baseUrl: string, fileName: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(fileName)}`;
}
