// Parsing of untrusted directive attributes into player options.
//
// `::video{file="out/demo.mp4" start="1:05" loop muted title="Demo"}`
// Every value arrives as a string; a bare attribute (`loop`) arrives as "".
// Invalid values produce error messages, never exceptions.
import { playerKindFor, type DirectiveName, type MediaKind, type MediaSource } from "./media.ts";
import { checkRequestedPath } from "./paths.ts";

export const MAX_TITLE_LENGTH = 200;
/** Upper bound for `start`, in seconds (one week); anything larger is a typo. */
export const MAX_START_SECONDS = 7 * 24 * 60 * 60;

export interface MediaOptions {
  file: string;
  source: MediaSource;
  title: string | null;
  start: number | null;
  loop: boolean;
  muted: boolean;
  kind: MediaKind;
}

export type ParseResult = { ok: true; value: MediaOptions } | { ok: false; errors: string[] };

const TRUE_WORDS = new Set(["", "true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

/** `loop`, `loop=""`, `loop="true"` → true; `"false"`/`"0"`/`"no"`/`"off"` → false; anything else is an error. */
export function parseBooleanAttribute(value: string | undefined, name: string): boolean | string {
  if (value === undefined) return false;
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return `"${name}" must be true or false, got ${JSON.stringify(value)}.`;
}

/**
 * `start` in seconds ("90", "12.5") or clock form ("1:30", "1:02:03.5").
 * Returns the number of seconds, null when absent, or an error message.
 */
export function parseStartAttribute(value: string | undefined): number | null | string {
  if (value === undefined) return null;
  const text = value.trim();
  const bad = `"start" must be seconds (90) or a time (1:30 or 1:02:03), got ${JSON.stringify(value)}.`;
  if (text.length === 0 || text.length > 16) return bad;
  let seconds: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d+)(\.\d+)?s?$/.exec(text)) !== null) {
    seconds = Number(match[1]) + (match[2] ? Number(match[2]) : 0);
  } else if ((match = /^(\d+):([0-5]\d)(\.\d+)?$/.exec(text)) !== null) {
    seconds = Number(match[1]) * 60 + Number(match[2]) + (match[3] ? Number(match[3]) : 0);
  } else if ((match = /^(\d+):([0-5]\d):([0-5]\d)(\.\d+)?$/.exec(text)) !== null) {
    seconds =
      Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + (match[4] ? Number(match[4]) : 0);
  } else {
    return bad;
  }
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_START_SECONDS) return bad;
  return seconds;
}

/** `source`: workspace (default) or thread-storage. */
export function parseSourceAttribute(value: string | undefined): MediaSource | string {
  if (value === undefined) return "workspace";
  const word = value.trim().toLowerCase();
  if (word === "" || word === "workspace") return "workspace";
  if (word === "thread-storage") return "thread-storage";
  return `"source" must be workspace or thread-storage, got ${JSON.stringify(value)}.`;
}

/** `title`: control characters removed, whitespace collapsed, capped at 200 characters. */
export function parseTitleAttribute(value: string | undefined): string | null {
  if (value === undefined) return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length === 0) return null;
  return clean.length > MAX_TITLE_LENGTH ? `${clean.slice(0, MAX_TITLE_LENGTH - 1)}…` : clean;
}

function own(attributes: Readonly<Record<string, string>>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(attributes, key)) return undefined;
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Parse every attribute the plugin knows. Unknown attributes are ignored so a
 * newer agent skill can add optional ones without breaking older installs.
 */
export function parseMediaAttributes(
  attributes: Readonly<Record<string, string>> | null | undefined,
  directive: DirectiveName,
): ParseResult {
  const attrs = attributes ?? {};
  const errors: string[] = [];

  const fileValue = own(attrs, "file");
  const path = checkRequestedPath(fileValue ?? "");
  const source = parseSourceAttribute(own(attrs, "source"));
  const start = parseStartAttribute(own(attrs, "start"));
  const loop = parseBooleanAttribute(own(attrs, "loop"), "loop");
  const muted = parseBooleanAttribute(own(attrs, "muted"), "muted");
  const title = parseTitleAttribute(own(attrs, "title"));

  if (!path.ok) errors.push(path.message);
  if (typeof source === "string" && source !== "workspace" && source !== "thread-storage") errors.push(source);
  if (typeof start === "string") errors.push(start);
  if (typeof loop === "string") errors.push(loop);
  if (typeof muted === "string") errors.push(muted);

  if (errors.length > 0 || !path.ok) return { ok: false, errors };
  const kind = playerKindFor(directive, path.path);
  if (kind === null) return { ok: false, errors: ['"file" must be a media file.'] };
  return {
    ok: true,
    value: {
      file: path.path,
      source: source as MediaSource,
      title,
      start: start as number | null,
      loop: loop as boolean,
      muted: muted as boolean,
      kind,
    },
  };
}
