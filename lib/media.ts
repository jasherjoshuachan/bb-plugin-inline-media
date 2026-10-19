// Media types the plugin will serve, and how a file name maps to a player.
//
// Everything here is pure so it can run on both sides (server validation and
// the player) and be unit tested with `node --test`.

export type MediaKind = "video" | "audio";

/** Where a relative `file` is looked up. */
export type MediaSource = "workspace" | "thread-storage";

/** Directive names registered by the app; `media` picks the player by extension. */
export type DirectiveName = "video" | "audio" | "media";

/**
 * The extension allowlist. Anything not listed is refused by the server, so a
 * directive can never be used to read source files, keys or databases.
 * `.ogg` is treated as audio (Ogg Vorbis/Opus); Ogg video uses `.ogv`.
 */
export const MEDIA_EXTENSIONS: Readonly<Record<string, MediaKind>> = Object.freeze({
  ".mp4": "video",
  ".m4v": "video",
  ".mov": "video",
  ".webm": "video",
  ".ogv": "video",
  ".mp3": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".oga": "audio",
  ".opus": "audio",
  ".flac": "audio",
});

/** Lower-cased extension of the last path segment (with the dot), or "" when none. */
export function extensionOf(filePath: string): string {
  const base = baseName(filePath);
  const dot = base.lastIndexOf(".");
  // A leading dot is a hidden file name, not an extension (".mp4" alone).
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot).toLowerCase();
}

/** Last segment of a path, accepting both separators. */
export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** The media kind for an allowlisted extension, or null when the file is not media. */
export function mediaKindForPath(filePath: string): MediaKind | null {
  const ext = extensionOf(filePath);
  if (ext === "") return null;
  return Object.prototype.hasOwnProperty.call(MEDIA_EXTENSIONS, ext) ? MEDIA_EXTENSIONS[ext]! : null;
}

export function isMediaPath(filePath: string): boolean {
  return mediaKindForPath(filePath) !== null;
}

/**
 * Which element renders a directive. `video` and `audio` force the element
 * (an `<audio>` plays the sound track of an .mp4 just fine, and a `<video>`
 * plays an .mp3 with an empty picture); `media` follows the extension.
 * Returns null when the file is not an allowlisted media file.
 */
export function playerKindFor(directive: DirectiveName, filePath: string): MediaKind | null {
  const detected = mediaKindForPath(filePath);
  if (detected === null) return null;
  if (directive === "media") return detected;
  return directive;
}

/** A readable list for error messages: ".mp4, .m4v, …". */
export function allowedExtensionsText(): string {
  return Object.keys(MEDIA_EXTENSIONS).join(", ");
}
