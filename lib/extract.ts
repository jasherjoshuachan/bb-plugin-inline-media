// Find every media file a message refers to: its attachments, path mentions,
// ::video/::audio/::media directives, markdown links, backticked paths and
// bare paths in the text. Pure string logic, shared by the "Play media"
// message action and its tests.
//
// The input is the message as bb's SDK returns it (`sdk.threads.message`):
// untrusted, so every field is read defensively. A reference is only a
// suggestion; the server decides whether it may be played.
import { baseName, mediaKindForPath, type MediaKind, type MediaSource } from "./media.ts";
import { checkRequestedPath, isAbsoluteLike } from "./paths.ts";

export type MediaOrigin = "attachment" | "mention" | "directive" | "link" | "path";

export interface MediaRef {
  /** Relative to `source`, or absolute (attached by path, Composer Dropzone drop, workspace file). */
  file: string;
  source: MediaSource;
  kind: MediaKind;
  /** Display name. */
  name: string;
  origin: MediaOrigin;
}

/** The parts of a bb message this module reads. Everything is optional and unchecked. */
export interface MessageLike {
  text?: unknown;
  attachments?: unknown;
  mentions?: unknown;
}

const MAX_REFS = 50;
const MAX_TEXT = 200_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `file:///Users/a/My%20Clip.mp4` → `/Users/a/My Clip.mp4`; null for anything else or a remote host. */
export function fileUrlToPath(href: string): string | null {
  if (!/^file:/i.test(href)) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;
  if (url.hostname !== "" && url.hostname !== "localhost") return null;
  try {
    const decoded = decodeURIComponent(url.pathname);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** A markdown link destination or bare token → a path candidate, or null when it's a URL or empty. */
function normalizeCandidate(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  if (value.length === 0) return null;
  if (/^file:/i.test(value)) return fileUrlToPath(value);
  // Other schemes (https:, data:, …) are not local files.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value)) return null;
  return value;
}

/** Link targets are URL-like: drop `?query`/`#fragment` and percent-decode. */
function normalizeLinkTarget(raw: string): string | null {
  const value = normalizeCandidate(raw);
  if (value === null || /^file:/i.test(raw.trim().replace(/^</, ""))) return value;
  const cut = value.search(/[?#]/);
  const bare = cut === -1 ? value : value.slice(0, cut);
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/** Strip punctuation a sentence wraps around a bare path. */
function trimToken(token: string): string {
  return token.replace(/^[("'[{*_]+/, "").replace(/[)"'\]},.;:!?*_]+$/, "");
}

/** Parse `file="a.mp4" source="thread-storage" loop` into a record. */
function parseDirectiveAttributes(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([a-zA-Z_][\w-]*)(?:\s*=\s*"([^"]*)")?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const key = match[1]!;
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = match[2] ?? "";
  }
  return out;
}

class RefCollector {
  readonly refs: MediaRef[] = [];
  private readonly seen = new Set<string>();

  add(file: string, source: MediaSource, origin: MediaOrigin, name?: string): void {
    if (this.refs.length >= MAX_REFS) return;
    const check = checkRequestedPath(file);
    if (!check.ok) return;
    // An absolute path is the same file whatever source was guessed.
    const effectiveSource: MediaSource = check.kind === "absolute" ? "workspace" : source;
    const key = `${effectiveSource}\u0000${check.path}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.refs.push({
      file: check.path,
      source: effectiveSource,
      kind: check.mediaKind,
      name: name !== undefined && name.trim().length > 0 ? name.trim() : baseName(check.path),
      origin,
    });
  }
}

/** Uploaded attachments are stored by bb under a generated name and copied to thread storage's Attachments/ folder by their display name. */
function uploadedAttachmentPath(storedPath: string, displayName: string | undefined): string {
  const name = baseName(displayName !== undefined && displayName.length > 0 ? displayName : storedPath);
  return `Attachments/${name}`;
}

function collectAttachments(attachments: unknown, out: RefCollector): void {
  if (!isRecord(attachments)) return;
  const details = Array.isArray(attachments.localFileDetails) ? attachments.localFileDetails : [];
  const covered = new Set<string>();
  for (const detail of details) {
    if (!isRecord(detail) || typeof detail.path !== "string") continue;
    covered.add(detail.path);
    const name = typeof detail.name === "string" ? detail.name : undefined;
    if (mediaKindForPath(name ?? detail.path) === null && mediaKindForPath(detail.path) === null) continue;
    if (isAbsoluteLike(detail.path)) out.add(detail.path, "workspace", "attachment", name);
    else out.add(uploadedAttachmentPath(detail.path, name), "thread-storage", "attachment", name);
  }
  const paths = Array.isArray(attachments.localFilePaths) ? attachments.localFilePaths : [];
  for (const entry of paths) {
    if (typeof entry !== "string" || covered.has(entry)) continue;
    if (isAbsoluteLike(entry)) out.add(entry, "workspace", "attachment");
    else out.add(uploadedAttachmentPath(entry, undefined), "thread-storage", "attachment");
  }
}

function collectMentions(mentions: unknown, out: RefCollector): void {
  if (!Array.isArray(mentions)) return;
  for (const mention of mentions) {
    const resource = isRecord(mention) ? mention.resource : undefined;
    if (!isRecord(resource) || typeof resource.path !== "string") continue;
    const label = typeof resource.label === "string" ? resource.label : undefined;
    if (resource.kind === "path" && resource.entryKind === "file") {
      const source: MediaSource = resource.source === "thread-storage" ? "thread-storage" : "workspace";
      out.add(resource.path, source, "mention");
    } else if (resource.kind === "attachment") {
      if (isAbsoluteLike(resource.path)) out.add(resource.path, "workspace", "attachment", label);
      else out.add(uploadedAttachmentPath(resource.path, label), "thread-storage", "attachment", label);
    }
  }
}

/** Media references in message text, in the order they appear. */
export function extractFromText(text: string): MediaRef[] {
  return collectFromText(text, new RefCollector(), []);
}

type Span = readonly [start: number, end: number];

/** Text ranges bb replaced with mention chips, so their labels aren't read as bare paths. */
function mentionSpans(mentions: unknown): Span[] {
  if (!Array.isArray(mentions)) return [];
  const spans: Span[] = [];
  for (const mention of mentions) {
    if (isRecord(mention) && typeof mention.start === "number" && typeof mention.end === "number" && mention.end > mention.start) {
      spans.push([mention.start, mention.end]);
    }
  }
  return spans;
}

function collectFromText(text: string, out: RefCollector, skip: readonly Span[]): MediaRef[] {
  const body = text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  type Hit = { index: number; add: () => void };
  const hits: Hit[] = [];
  // Directives, links and code spans claim their text; bare-path scanning skips it.
  const covered: Span[] = [...skip];
  const claim = (match: RegExpMatchArray) => covered.push([match.index!, match.index! + match[0].length]);
  const isCovered = (index: number) => covered.some(([start, end]) => index >= start && index < end);

  // ::video{file="..."} directives on their own line.
  for (const match of body.matchAll(/^[ \t]*::(video|audio|media)\{([^}\n]*)\}[ \t]*$/gm)) {
    const attrs = parseDirectiveAttributes(match[2]!);
    claim(match);
    const file = attrs.file;
    if (file === undefined) continue;
    const source: MediaSource = attrs.source?.trim().toLowerCase() === "thread-storage" ? "thread-storage" : "workspace";
    const title = attrs.title;
    hits.push({ index: match.index!, add: () => out.add(file, source, "directive", title) });
  }
  // [label](target) and ![alt](target), with an optional "title".
  for (const match of body.matchAll(/!?\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g)) {
    claim(match);
    const target = normalizeLinkTarget(match[2]!);
    if (target === null) continue;
    hits.push({ index: match.index!, add: () => out.add(target, "workspace", "link") });
  }
  // `backticked/path.mp4` (may contain spaces).
  for (const match of body.matchAll(/`([^`\n]{1,1024})`/g)) {
    claim(match);
    const candidate = normalizeCandidate(match[1]!);
    if (candidate === null) continue;
    hits.push({ index: match.index!, add: () => out.add(candidate, "workspace", "path") });
  }
  // Bare paths: whitespace-separated tokens with a media extension.
  for (const match of body.matchAll(/[^\s`<>]+/g)) {
    if (isCovered(match.index!)) continue;
    const token = trimToken(match[0]);
    if (token.length === 0 || /[{}="'|*\[\]()]/.test(token) || token.startsWith("::")) continue;
    if (mediaKindForPath(token) === null) continue;
    const candidate = normalizeCandidate(token);
    if (candidate === null) continue;
    hits.push({ index: match.index!, add: () => out.add(candidate, "workspace", "path") });
  }

  hits.sort((a, b) => a.index - b.index);
  for (const hit of hits) hit.add();
  return out.refs;
}

/**
 * Every media file a message refers to, attachments first, then mentions,
 * then the text in reading order. Duplicates are dropped and the list is
 * capped at 50. Never throws.
 */
export function extractMediaRefs(message: MessageLike | null | undefined): MediaRef[] {
  const out = new RefCollector();
  if (!isRecord(message)) return out.refs;
  try {
    collectAttachments(message.attachments, out);
    collectMentions(message.mentions, out);
    if (typeof message.text === "string") collectFromText(message.text, out, mentionSpans(message.mentions));
  } catch {
    // Malformed input: return what was found so far.
  }
  return out.refs;
}
