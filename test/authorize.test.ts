import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachedFilesFromMessage,
  attachedFilesFromPromptHistory,
  exposesProtectedLocation,
  isAttachedPath,
  isProtectedLocation,
} from "../lib/authorize.ts";

const HOME = "/Users/example";
const DATA = "/Users/example/.bb";
const DROPS = "/Users/example/.bb/plugins/composer-dropzone/drops";
const guard = { home: HOME, dataDir: DATA, dropsDir: DROPS };

describe("isProtectedLocation", () => {
  for (const bad of [
    "/Users/example/.ssh/id_ed25519.mp4",
    "/Users/example/.gnupg/a.mp3",
    "/Users/example/.aws/x.mp4",
    "/Users/example/.config/gh/clip.mp4",
    "/Users/example/.claude/projects/a.mp4",
    "/Users/example/.claude-work/x.mp4",
    "/Users/example/.claude.json.mp4",
    "/Users/example/.bb/thread-storage/thr_x/a.mp4",
    "/Users/example/.bb/plugins/other/a.mp4",
    "/Users/example/.bb/plugins/composer-dropzone/drops/.partial/u.mp4",
    "/Users/example/Library/Keychains/login.mp4",
    "/Users/example/Library/Cookies/c.mp4",
    "/Users/example/.ssh",
  ]) {
    it(`refuses ${bad}`, () => assert.equal(isProtectedLocation(bad, guard), true));
  }
  for (const good of [
    "/Users/example/Movies/clip.mp4",
    "/Users/example/Projects/site/out/video.mp4",
    "/Users/example/claude/notes.mp4",
    "/Users/example/.bb/plugins/composer-dropzone/drops/2026-10-19/a.mp4",
    "/Volumes/Media/clip.mov",
  ]) {
    it(`allows ${good}`, () => assert.equal(isProtectedLocation(good, guard), false));
  }
  it("protects the drops folder too when drops are off", () => {
    assert.equal(isProtectedLocation(`${DROPS}/2026-10-19/a.mp4`, { ...guard, dropsDir: null }), true);
  });
  it("protects a bb data folder outside the home folder", () => {
    assert.equal(isProtectedLocation("/srv/bb/attachments/a.mp4", { ...guard, dataDir: "/srv/bb" }), true);
  });
  it("resolves . and // before deciding", () => {
    assert.equal(isProtectedLocation("/Users/example/./.ssh//k.mp4", guard), true);
  });
});

describe("exposesProtectedLocation", () => {
  it("refuses folders that contain the home folder or a protected folder", () => {
    for (const dir of ["/", "/Users", HOME, `${HOME}/`, `${HOME}/.bb`, `${HOME}/Library`, `${HOME}/.ssh`]) {
      assert.equal(exposesProtectedLocation(dir, guard), true, dir);
    }
  });
  it("allows ordinary folders, including drops and thread storage subfolders", () => {
    for (const dir of [`${HOME}/Movies`, `${HOME}/Projects/site/out`, `${DROPS}/2026-10-19`, `${HOME}/.bb/thread-storage/thr_x/Attachments`, "/tmp/clips"]) {
      assert.equal(exposesProtectedLocation(dir, guard), false, dir);
    }
  });
});

describe("attached files", () => {
  const history = [
    {
      id: "p1",
      createdAt: 1,
      input: [
        { type: "text", text: "Check this", mentions: [{ start: 0, end: 1, resource: { kind: "attachment", label: "m.mp4", path: "/Users/example/m.mp4" } }] },
        { type: "localFile", path: "/Users/example/Projects/site/out/video.mp4", name: "video.mp4", hostId: "host_a" },
        { type: "localFile", path: "upload-123.mp4", name: "upload.mp4", sourceProjectId: "proj_x" },
        { type: "localImage", path: "/Users/example/shot.png", hostId: "host_a" },
        { type: "localFile", path: "/Users/example/Movies/nohost.mov" },
      ],
    },
    { bogus: true },
    null,
  ];

  it("reads absolute localFile inputs and attachment mentions from prompt history", () => {
    assert.deepEqual(attachedFilesFromPromptHistory(history), [
      { path: "/Users/example/m.mp4", hostId: null },
      { path: "/Users/example/Projects/site/out/video.mp4", hostId: "host_a" },
      { path: "/Users/example/Movies/nohost.mov", hostId: null },
    ]);
    assert.deepEqual(attachedFilesFromPromptHistory("nope"), []);
  });

  it("reads absolute attachments from one message", () => {
    const message = {
      attachments: {
        localFilePaths: ["/Users/example/a.mp4", "upload.mp4"],
        localFileDetails: [{ path: "/Users/example/a.mp4", name: "a.mp4", sizeBytes: 1 }],
      },
      mentions: [{ resource: { kind: "attachment", path: "/Users/example/b.mp4", label: "b" } }],
    };
    assert.deepEqual(
      attachedFilesFromMessage(message).map((file) => file.path),
      ["/Users/example/a.mp4", "/Users/example/a.mp4", "/Users/example/b.mp4"],
    );
    assert.deepEqual(attachedFilesFromMessage(null), []);
  });

  it("requires the exact path on the serving host", () => {
    const attached = attachedFilesFromPromptHistory(history);
    const ok = (p: string, host = "host_a") => isAttachedPath(p, attached, host, "host_a");
    assert.equal(ok("/Users/example/Projects/site/out/video.mp4"), true);
    assert.equal(ok("/Users/example/Projects/site/out/./video.mp4"), true);
    // A file without a recorded host counts as the primary host.
    assert.equal(ok("/Users/example/Movies/nohost.mov"), true);
    assert.equal(ok("/Users/example/m.mp4"), true);
    // Siblings, other names, case changes and relative paths are not attachments.
    assert.equal(ok("/Users/example/Projects/site/out/other.mp4"), false);
    assert.equal(ok("/Users/example/Projects/site/out/VIDEO.mp4"), false);
    assert.equal(ok("/Users/example/Projects/site/out"), false);
    assert.equal(ok("Projects/site/out/video.mp4"), false);
    assert.equal(ok("/Users/example/shot.png"), false);
    // A different host is refused.
    assert.equal(ok("/Users/example/Projects/site/out/video.mp4", "host_b"), false);
    assert.equal(isAttachedPath("/Users/example/Movies/nohost.mov", attached, "host_b", "host_a"), false);
    assert.equal(isAttachedPath("/Users/example/Movies/nohost.mov", attached, null, null), false);
    assert.equal(isAttachedPath("/Users/example/Movies/nohost.mov", [], "host_a", "host_a"), false);
  });
});
