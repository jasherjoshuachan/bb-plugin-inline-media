import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_START_SECONDS,
  parseBooleanAttribute,
  parseMediaAttributes,
  parseSourceAttribute,
  parseStartAttribute,
  parseTitleAttribute,
} from "../lib/attributes.ts";

describe("parseStartAttribute", () => {
  it("is null when absent", () => {
    assert.equal(parseStartAttribute(undefined), null);
  });
  it("reads seconds", () => {
    assert.equal(parseStartAttribute("0"), 0);
    assert.equal(parseStartAttribute("90"), 90);
    assert.equal(parseStartAttribute("12.5"), 12.5);
    assert.equal(parseStartAttribute(" 7 "), 7);
    assert.equal(parseStartAttribute("30s"), 30);
  });
  it("reads m:ss and h:mm:ss", () => {
    assert.equal(parseStartAttribute("1:30"), 90);
    assert.equal(parseStartAttribute("0:05"), 5);
    assert.equal(parseStartAttribute("90:00"), 5400);
    assert.equal(parseStartAttribute("1:02:03"), 3723);
    assert.equal(parseStartAttribute("1:02:03.5"), 3723.5);
  });
  it("refuses bad values with a message", () => {
    for (const bad of ["", " ", "-1", "abc", "1:60", "1:5", "1:02:60", "1e3", "Infinity", "NaN", "0x10", "1,5", "1:2:3:4", ".5", "5.", "12345678901234567"]) {
      assert.equal(typeof parseStartAttribute(bad), "string", bad);
    }
  });
  it("caps at one week", () => {
    assert.equal(parseStartAttribute(String(MAX_START_SECONDS)), MAX_START_SECONDS);
    assert.equal(typeof parseStartAttribute(String(MAX_START_SECONDS + 1)), "string");
    assert.equal(typeof parseStartAttribute("999:00:00"), "string");
  });
});

describe("parseBooleanAttribute", () => {
  it("is false when absent", () => {
    assert.equal(parseBooleanAttribute(undefined, "loop"), false);
  });
  it("treats a bare attribute and true-ish words as true", () => {
    for (const value of ["", "true", "TRUE", "1", "yes", "on", " true "]) {
      assert.equal(parseBooleanAttribute(value, "loop"), true, value);
    }
  });
  it("treats false-ish words as false", () => {
    for (const value of ["false", "False", "0", "no", "off"]) {
      assert.equal(parseBooleanAttribute(value, "loop"), false, value);
    }
  });
  it("refuses anything else", () => {
    for (const value of ["maybe", "2", "y", "loop", "null"]) {
      const result = parseBooleanAttribute(value, "muted");
      assert.equal(typeof result, "string", value);
      assert.match(result as string, /"muted"/);
    }
  });
});

describe("parseSourceAttribute", () => {
  it("defaults to workspace", () => {
    assert.equal(parseSourceAttribute(undefined), "workspace");
    assert.equal(parseSourceAttribute(""), "workspace");
  });
  it("accepts both sources, case-insensitively", () => {
    assert.equal(parseSourceAttribute("workspace"), "workspace");
    assert.equal(parseSourceAttribute("Thread-Storage"), "thread-storage");
  });
  it("refuses others", () => {
    for (const bad of ["host", "drops", "url", "thread"]) {
      assert.match(String(parseSourceAttribute(bad)), /must be workspace or thread-storage/);
    }
  });
});

describe("parseTitleAttribute", () => {
  it("is null when absent or blank", () => {
    assert.equal(parseTitleAttribute(undefined), null);
    assert.equal(parseTitleAttribute("   "), null);
  });
  it("strips control characters and collapses whitespace", () => {
    assert.equal(parseTitleAttribute("  Demo\n\tcut\u0000 1 "), "Demo cut 1");
  });
  it("caps the length", () => {
    const title = parseTitleAttribute("x".repeat(500));
    assert.equal(title?.length, 200);
    assert.ok(title?.endsWith("…"));
  });
  it("keeps markup as plain text (React escapes it)", () => {
    assert.equal(parseTitleAttribute("<img src=x onerror=alert(1)>"), "<img src=x onerror=alert(1)>");
  });
});

describe("parseMediaAttributes", () => {
  it("parses a full directive", () => {
    const result = parseMediaAttributes(
      { file: "out/demo.mp4", source: "workspace", title: "Demo", start: "1:05", loop: "", muted: "true" },
      "video",
    );
    assert.deepEqual(result, {
      ok: true,
      value: { file: "out/demo.mp4", source: "workspace", title: "Demo", start: 65, loop: true, muted: true, kind: "video" },
    });
  });
  it("applies defaults", () => {
    const result = parseMediaAttributes({ file: "memo.m4a" }, "audio");
    assert.deepEqual(result, {
      ok: true,
      value: { file: "memo.m4a", source: "workspace", title: null, start: null, loop: false, muted: false, kind: "audio" },
    });
  });
  it("media picks the player from the extension", () => {
    const video = parseMediaAttributes({ file: "a.webm" }, "media");
    const audio = parseMediaAttributes({ file: "a.flac" }, "media");
    assert.ok(video.ok && video.value.kind === "video");
    assert.ok(audio.ok && audio.value.kind === "audio");
  });
  it("video and audio force the element", () => {
    const audioOfMp4 = parseMediaAttributes({ file: "talk.mp4" }, "audio");
    const videoOfMp3 = parseMediaAttributes({ file: "song.mp3" }, "video");
    assert.ok(audioOfMp4.ok && audioOfMp4.value.kind === "audio");
    assert.ok(videoOfMp3.ok && videoOfMp3.value.kind === "video");
  });
  it("ignores unknown attributes", () => {
    const result = parseMediaAttributes({ file: "a.mp4", autoplay: "", poster: "x.png", id: "x" }, "video");
    assert.ok(result.ok);
  });
  it("does not read inherited properties", () => {
    const attrs = Object.create({ file: "inherited.mp4" }) as Record<string, string>;
    assert.equal(parseMediaAttributes(attrs, "video").ok, false);
  });
  it("tolerates missing attributes objects", () => {
    assert.equal(parseMediaAttributes(undefined, "video").ok, false);
    assert.equal(parseMediaAttributes(null, "media").ok, false);
  });
  it("collects every error instead of throwing", () => {
    const result = parseMediaAttributes({ file: "../x.txt", source: "host", start: "soon", loop: "maybe", muted: "2" }, "video");
    assert.equal(result.ok, false);
    assert.equal(result.ok ? 0 : result.errors.length, 5);
  });
  it("refuses a missing file, a URL and a non-media file", () => {
    for (const attrs of [{} as Record<string, string>, { file: "" }, { file: "https://e.com/a.mp4" }, { file: "a.html" }, { file: "~/a.mp4" }]) {
      const result = parseMediaAttributes(attrs, "video");
      assert.equal(result.ok, false, JSON.stringify(attrs));
    }
  });
  it("lets absolute paths through to the server", () => {
    const result = parseMediaAttributes({ file: "/somewhere/drops/2026-10-19/a.mp4" }, "media");
    assert.ok(result.ok);
  });
});
