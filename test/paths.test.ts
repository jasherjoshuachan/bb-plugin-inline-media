import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRequestedPath, isAbsoluteLike, joinPreviewUrl, splitRelative } from "../lib/paths.ts";

function code(value: unknown): string {
  const result = checkRequestedPath(value);
  return result.ok ? `ok:${result.kind}:${result.path}` : result.code;
}

describe("checkRequestedPath: accepted paths", () => {
  it("accepts a plain relative media path", () => {
    assert.equal(code("out/demo.mp4"), "ok:relative:out/demo.mp4");
  });
  it("normalizes ./, duplicate slashes and backslashes", () => {
    assert.equal(code("./out//clips/./demo.webm"), "ok:relative:out/clips/demo.webm");
    assert.equal(code("out\\clips\\demo.mov"), "ok:relative:out/clips/demo.mov");
  });
  it("trims surrounding whitespace", () => {
    assert.equal(code("  memo.m4a  "), "ok:relative:memo.m4a");
  });
  it("keeps spaces, unicode and dots inside names", () => {
    assert.equal(code("renders/My Demo v1.2 — final.mp4"), "ok:relative:renders/My Demo v1.2 — final.mp4");
    assert.equal(code("音声/メモ.mp3"), "ok:relative:音声/メモ.mp3");
    assert.equal(code("a..b.mp4"), "ok:relative:a..b.mp4");
    assert.equal(code("...mp4"), "ok:relative:...mp4");
  });
  it("reports the media kind", () => {
    const video = checkRequestedPath("a.MOV");
    const audio = checkRequestedPath("a.Opus");
    assert.ok(video.ok && video.mediaKind === "video");
    assert.ok(audio.ok && audio.mediaKind === "audio");
  });
  it("passes absolute paths through as kind absolute (the server decides)", () => {
    assert.equal(code("/data/plugins/composer-dropzone/drops/2026-01-01/x.mp4"), "ok:absolute:/data/plugins/composer-dropzone/drops/2026-01-01/x.mp4");
    assert.equal(code("C:\\Users\\a\\x.mp4"), "ok:absolute:C:\\Users\\a\\x.mp4");
    assert.equal(code("\\\\server\\share\\x.mp4"), "ok:absolute:\\\\server\\share\\x.mp4");
  });
});

describe("checkRequestedPath: traversal", () => {
  const cases = [
    "../secret.mp4",
    "out/../../secret.mp4",
    "out/..",
    "..",
    "..\\secret.mp4",
    "out\\..\\..\\x.mp4",
    "a/b/../c.mp4",
    "/abs/../etc/x.mp4",
    "C:\\a\\..\\x.mp4",
    "%2e%2e/secret.mp4",
    "%2E%2E/secret.mp4",
    ".%2e/secret.mp4",
    "%252e%252e/secret.mp4",
    "a%2F..%2Fb.mp4",
    "a%2fb.mp4",
    "a%5c..%5cb.mp4",
  ];
  for (const value of cases) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      assert.equal(code(value), "traversal");
    });
  }
  it("allows a literal percent that is not an escape of a separator or dots", () => {
    assert.equal(code("100%25 done.mp4"), "ok:relative:100%25 done.mp4");
    assert.equal(code("bad%zzescape.mp4"), "ok:relative:bad%zzescape.mp4");
    assert.equal(code("50% off.mp3"), "ok:relative:50% off.mp3");
  });
});

describe("checkRequestedPath: URLs, schemes and home", () => {
  for (const value of ["https://example.com/a.mp4", "http://x/a.mp3", "HTTPS://X/A.MP4", "ftp://x/a.mp4", "wss://x/a.mp4"]) {
    it(`refuses remote ${value}`, () => assert.equal(code(value), "remote-url"));
  }
  it("refuses protocol-relative URLs", () => {
    assert.equal(code("//example.com/a.mp4"), "remote-url");
  });
  for (const value of ["file:///etc/a.mp4", "data:video/mp4;base64,AAAA", "blob:x.mp4", "javascript:alert(1)//.mp4", "C:relative.mp4"]) {
    it(`refuses scheme ${value}`, () => assert.equal(code(value), "scheme"));
  }
  for (const value of ["~/Movies/a.mp4", "~", "~root/a.mp4", "~\\a.mp4"]) {
    it(`refuses home path ${value}`, () => assert.equal(code(value), "home"));
  }
});

describe("checkRequestedPath: shape", () => {
  it("refuses non-strings", () => {
    assert.equal(code(undefined), "not-string");
    assert.equal(code(42), "not-string");
    assert.equal(code(null), "not-string");
    assert.equal(code(["a.mp4"]), "not-string");
  });
  it("refuses empty or dot-only values", () => {
    assert.equal(code(""), "empty");
    assert.equal(code("   "), "empty");
    assert.equal(code("."), "empty");
    assert.equal(code("./"), "empty");
  });
  it("refuses overlong values", () => {
    assert.equal(code(`${"a/".repeat(600)}x.mp4`), "too-long");
  });
  it("refuses control characters, including NUL and newlines", () => {
    assert.equal(code("a\u0000.mp4"), "control-chars");
    assert.equal(code("a.mp4\u0000.txt"), "control-chars");
    assert.equal(code("a\nb.mp4"), "control-chars");
    assert.equal(code("a\u007f.mp4"), "control-chars");
  });
});

describe("checkRequestedPath: extension allowlist", () => {
  const allowed = [".mp4", ".m4v", ".mov", ".webm", ".ogv", ".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac"];
  for (const ext of allowed) {
    it(`accepts ${ext} in any case`, () => {
      assert.ok(checkRequestedPath(`a${ext}`).ok);
      assert.ok(checkRequestedPath(`a${ext.toUpperCase()}`).ok);
    });
  }
  const refused = [
    "notes.txt",
    "index.html",
    "a.svg",
    "server.ts",
    ".env",
    "id_rsa",
    "bb.db",
    "a.mp4.txt",
    "a.mp4/",
    "a.mkv",
    "a.avi",
    "a.mp4 ",
    ".mp4",
    "dir.mp4/inner",
    "a.",
    "noext",
  ];
  for (const value of refused) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      const result = checkRequestedPath(value);
      // "a.mp4 " is trimmed and therefore valid; everything else is not media.
      if (value === "a.mp4 ") assert.ok(result.ok);
      else assert.equal(result.ok ? "ok" : result.code, "not-media");
    });
  }
  it("checks the extension of absolute paths too", () => {
    assert.equal(code("/drops/x.txt"), "not-media");
  });
});

describe("helpers", () => {
  it("isAbsoluteLike", () => {
    assert.equal(isAbsoluteLike("/a"), true);
    assert.equal(isAbsoluteLike("\\a"), true);
    assert.equal(isAbsoluteLike("D:/a"), true);
    assert.equal(isAbsoluteLike("a/b"), false);
    assert.equal(isAbsoluteLike("D:a"), false);
  });
  it("splitRelative", () => {
    assert.deepEqual(splitRelative("a.mp4"), { directory: "", fileName: "a.mp4" });
    assert.deepEqual(splitRelative("out/clips/a.mp4"), { directory: "out/clips", fileName: "a.mp4" });
  });
  it("joinPreviewUrl encodes the name as one segment", () => {
    assert.equal(joinPreviewUrl("/api/p/abc/", "a b#?.mp4"), "/api/p/abc/a%20b%23%3F.mp4");
    assert.equal(joinPreviewUrl("/api/p/abc", "x.mp4"), "/api/p/abc/x.mp4");
    assert.equal(joinPreviewUrl("/api/p/abc//", "a/b.mp4"), "/api/p/abc/a%2Fb.mp4");
  });
});
