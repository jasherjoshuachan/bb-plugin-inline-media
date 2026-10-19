import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractFromText, extractMediaRefs, fileUrlToPath } from "../lib/extract.ts";

function files(refs: { file: string; source: string }[]): string[] {
  return refs.map((ref) => (ref.source === "workspace" ? ref.file : `${ref.source}:${ref.file}`));
}

describe("fileUrlToPath", () => {
  it("decodes local file URLs", () => {
    assert.equal(fileUrlToPath("file:///Users/example/My%20Clip%20%231.mov"), "/Users/example/My Clip #1.mov");
    assert.equal(fileUrlToPath("file://localhost/tmp/a.mp4"), "/tmp/a.mp4");
  });
  it("refuses other schemes, remote hosts and junk", () => {
    assert.equal(fileUrlToPath("https://example.com/a.mp4"), null);
    assert.equal(fileUrlToPath("file://server/share/a.mp4"), null);
    assert.equal(fileUrlToPath("file:///bad%zz.mp4"), null);
    assert.equal(fileUrlToPath("out/a.mp4"), null);
  });
});

describe("extractFromText", () => {
  it("finds directives, honoring source and title", () => {
    const refs = extractFromText(
      'Here it is:\n\n::video{file="out/demo.mp4" title="Demo"}\n\n::audio{file="memo.m4a" source="thread-storage"}\n',
    );
    assert.deepEqual(files(refs), ["out/demo.mp4", "thread-storage:memo.m4a"]);
    assert.equal(refs[0]?.name, "Demo");
    assert.equal(refs[0]?.kind, "video");
    assert.equal(refs[0]?.origin, "directive");
    assert.equal(refs[1]?.kind, "audio");
  });
  it("finds markdown links, including angle brackets, titles, file URLs and encoded names", () => {
    const refs = extractFromText(
      [
        "See [the cut](out/cut%201.mp4) and ![poster](renders/intro.webm \"Intro\").",
        "Also [voice](<voice over/take 2.m4a>) and [abs](file:///Users/example/Movies/clip.mov).",
        "And [jump](out/demo.mp4#t=10) plus [docs](README.md) and [web](https://example.com/x.mp4).",
      ].join("\n"),
    );
    assert.deepEqual(files(refs), [
      "out/cut 1.mp4",
      "renders/intro.webm",
      "voice over/take 2.m4a",
      "/Users/example/Movies/clip.mov",
      "out/demo.mp4",
    ]);
    assert.ok(refs.every((ref) => ref.origin === "link"));
  });
  it("finds backticked paths, with spaces", () => {
    const refs = extractFromText("Saved to `exports/final cut.mov` and `notes.txt`.");
    assert.deepEqual(files(refs), ["exports/final cut.mov"]);
  });
  it("finds bare paths and strips sentence punctuation", () => {
    const refs = extractFromText("Rendered out/a.mp4, then (clips/b.MP3). Finally **c.wav** and /Users/example/d.flac!");
    assert.deepEqual(files(refs), ["out/a.mp4", "clips/b.MP3", "c.wav", "/Users/example/d.flac"]);
  });
  it("keeps reading order and drops duplicates", () => {
    const refs = extractFromText("`b.mp4` then [a](a.mp4) then b.mp4 again and ::video{file=\"a.mp4\"} inline");
    assert.deepEqual(files(refs), ["b.mp4", "a.mp4"]);
  });
  it("ignores URLs, traversal, home paths, non-media files and directive fragments", () => {
    const refs = extractFromText(
      [
        "https://example.com/a.mp4 ftp://x/b.mp3 data:video/mp4;base64,AAAA",
        "../outside/c.mp4 a/../../d.mp4 ~/Movies/e.mp4 notes.md image.png",
        'file="x.mp4" ::video{file="y.mp4"} trailing',
        "C:/Windows/f.mp4",
      ].join("\n"),
    );
    // The inline ::video isn't on its own line, so it isn't a directive, and its fragments aren't paths.
    assert.deepEqual(files(refs), ["C:/Windows/f.mp4"]);
  });
  it("caps the number of references", () => {
    const text = Array.from({ length: 80 }, (_, i) => `clip-${i}.mp4`).join(" ");
    assert.equal(extractFromText(text).length, 50);
  });
});

describe("extractMediaRefs", () => {
  it("reads attachments: absolute paths as-is, uploads from thread storage's Attachments folder", () => {
    const refs = extractMediaRefs({
      text: "Check video now.",
      attachments: {
        localFilePaths: ["/Users/example/Projects/site/out/video.mp4", "clip-1790000000000-abc123.mp4", "/Users/example/report.pdf"],
        localFileDetails: [
          { path: "/Users/example/Projects/site/out/video.mp4", name: "video.mp4", sizeBytes: 10 },
          { path: "clip-1790000000000-abc123.mp4", name: "clip.mp4", sizeBytes: 20 },
          { path: "/Users/example/report.pdf", name: "report.pdf", sizeBytes: 30 },
        ],
        localImagePaths: ["shot.png"],
      },
    });
    assert.deepEqual(files(refs), ["/Users/example/Projects/site/out/video.mp4", "thread-storage:Attachments/clip.mp4"]);
    assert.equal(refs[1]?.name, "clip.mp4");
    assert.ok(refs.every((ref) => ref.origin === "attachment"));
  });
  it("falls back to localFilePaths when details are missing", () => {
    const refs = extractMediaRefs({ attachments: { localFilePaths: ["/tmp/drop/a.mov", "upload-123.m4a"] } });
    assert.deepEqual(files(refs), ["/tmp/drop/a.mov", "thread-storage:Attachments/upload-123.m4a"]);
  });
  it("reads path and attachment mentions", () => {
    const refs = extractMediaRefs({
      text: "look at @demo.mp4",
      mentions: [
        { start: 8, end: 17, resource: { kind: "path", entryKind: "file", path: "out/demo.mp4", source: "workspace", label: "demo.mp4" } },
        { start: 0, end: 1, resource: { kind: "path", entryKind: "directory", path: "out", source: "workspace", label: "out" } },
        { start: 0, end: 1, resource: { kind: "path", entryKind: "file", path: "rec.m4a", source: "thread-storage", label: "rec.m4a" } },
        { start: 0, end: 1, resource: { kind: "attachment", path: "/Users/example/clip.webm", label: "clip.webm" } },
        { start: 0, end: 1, resource: { kind: "thread", threadId: "thr_x", label: "x" } },
      ],
    });
    assert.deepEqual(files(refs), ["out/demo.mp4", "thread-storage:rec.m4a", "/Users/example/clip.webm"]);
  });
  it("puts attachments first, then mentions, then text", () => {
    const refs = extractMediaRefs({
      text: "Made out/b.mp4",
      attachments: { localFileDetails: [{ path: "/abs/a.mp4", name: "a.mp4", sizeBytes: null }] },
      mentions: [{ resource: { kind: "path", entryKind: "file", path: "m.mp3", source: "workspace" } }],
    });
    assert.deepEqual(files(refs), ["/abs/a.mp4", "m.mp3", "out/b.mp4"]);
  });
  it("never throws on malformed input", () => {
    for (const bad of [null, undefined, 5, "text", [], { text: 5, attachments: "x", mentions: {} }, { attachments: { localFileDetails: [null, 3, { path: 4 }] } }]) {
      assert.deepEqual(extractMediaRefs(bad as never), []);
    }
  });
  it("returns nothing for a message without media", () => {
    assert.deepEqual(extractMediaRefs({ text: "All done. See README.md and https://example.com.", attachments: null, mentions: [] }), []);
  });
});
