import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dropsDirFromDatabaseName,
  isStrictlyInside,
  planMediaRequest,
  resolveInsideRoot,
  type PlanInput,
} from "../lib/roots.ts";

const DROPS = "/data/bb/plugins/composer-dropzone/drops";

function plan(path: unknown, overrides: Partial<PlanInput> = {}) {
  return planMediaRequest({ path, source: "workspace", dropsDir: DROPS, allowDropzoneFolder: true, ...overrides });
}

describe("dropsDirFromDatabaseName", () => {
  it("goes from this plugin's database to Composer Dropzone's drops folder", () => {
    assert.equal(dropsDirFromDatabaseName("/data/bb/plugins/inline-media/data.db"), DROPS);
  });
  it("does not depend on this plugin's id", () => {
    assert.equal(dropsDirFromDatabaseName("/data/bb/plugins/some-fork/data.db"), DROPS);
  });
});

describe("isStrictlyInside", () => {
  it("accepts children and grandchildren", () => {
    assert.equal(isStrictlyInside("/a/b", "/a/b/c.mp4"), true);
    assert.equal(isStrictlyInside("/a/b", "/a/b/c/d.mp4"), true);
    assert.equal(isStrictlyInside("/a/b/", "/a/b/c.mp4"), true);
  });
  it("refuses the directory itself, parents, siblings and prefix look-alikes", () => {
    assert.equal(isStrictlyInside("/a/b", "/a/b"), false);
    assert.equal(isStrictlyInside("/a/b", "/a"), false);
    assert.equal(isStrictlyInside("/a/b", "/a/c/x.mp4"), false);
    assert.equal(isStrictlyInside("/a/b", "/a/bc/x.mp4"), false);
    assert.equal(isStrictlyInside("/a/b", "/a/b/../c/x.mp4"), false);
    assert.equal(isStrictlyInside("/a/b", "/a/b/..x/y.mp4"), true);
  });
});

describe("resolveInsideRoot", () => {
  it("resolves normal relative paths", () => {
    assert.equal(resolveInsideRoot("/ws", "out/a.mp4"), "/ws/out/a.mp4");
  });
  it("refuses anything that escapes (defense in depth behind checkRequestedPath)", () => {
    assert.equal(resolveInsideRoot("/ws", "../a.mp4"), null);
    assert.equal(resolveInsideRoot("/ws", "out/../../a.mp4"), null);
    assert.equal(resolveInsideRoot("/ws", "/etc/a.mp4"), null);
    assert.equal(resolveInsideRoot("/ws", ""), null);
  });
});

describe("planMediaRequest: relative paths", () => {
  it("serves from the workspace by default", () => {
    const result = plan("out/clips/demo.mp4");
    assert.ok(result.ok);
    assert.equal(result.root, "workspace");
    assert.equal(result.relativePath, "out/clips/demo.mp4");
    assert.equal(result.directory, "out/clips");
    assert.equal(result.fileName, "demo.mp4");
    assert.equal(result.mediaKind, "video");
    assert.equal(result.absolutePath, null);
  });
  it("serves from thread storage when asked", () => {
    const result = plan("memo.m4a", { source: "thread-storage" });
    assert.ok(result.ok);
    assert.equal(result.root, "thread-storage");
    assert.equal(result.directory, "");
    assert.equal(result.mediaKind, "audio");
  });
  it("normalizes before planning", () => {
    const result = plan("./out\\demo.MP4");
    assert.ok(result.ok);
    assert.equal(result.relativePath, "out/demo.MP4");
  });
  for (const bad of ["../x.mp4", "a/../../x.mp4", "https://e.com/x.mp4", "~/x.mp4", "x.txt", "", "x.mp4\u0000.txt"]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      assert.equal(plan(bad).ok, false);
    });
  }
});

describe("planMediaRequest: absolute paths", () => {
  it("allows a file inside the drops folder", () => {
    const result = plan(`${DROPS}/2026-10-19/1a2b3c4d-clip.mov`);
    assert.ok(result.ok);
    assert.equal(result.root, "drops");
    assert.equal(result.absolutePath, `${DROPS}/2026-10-19/1a2b3c4d-clip.mov`);
    assert.equal(result.directory, `${DROPS}/2026-10-19`);
    assert.equal(result.fileName, "1a2b3c4d-clip.mov");
    assert.equal(result.relativePath, null);
  });
  it("ignores source for drops (the root is fixed)", () => {
    const result = plan(`${DROPS}/2026-10-19/a.mp3`, { source: "thread-storage" });
    assert.ok(result.ok);
    assert.equal(result.root, "drops");
  });
  it("refuses drops when the setting is off", () => {
    assert.equal(plan(`${DROPS}/2026-10-19/a.mp4`, { allowDropzoneFolder: false }).ok, false);
  });
  it("refuses drops when the folder is unknown", () => {
    assert.equal(plan(`${DROPS}/2026-10-19/a.mp4`, { dropsDir: null }).ok, false);
  });
  it("refuses absolute paths outside the drops folder", () => {
    for (const bad of [
      "/etc/a.mp4",
      "/data/bb/plugins/composer-dropzone/a.mp4",
      "/data/bb/plugins/composer-dropzone/drops-evil/a.mp4",
      "/data/bb/plugins/composer-dropzone/dropsa.mp4",
      "/data/bb/plugins/inline-media/a.mp4",
      "/home/someone/Movies/a.mp4",
    ]) {
      assert.equal(plan(bad).ok, false, bad);
    }
  });
  it("refuses the drops folder itself and traversal out of it", () => {
    assert.equal(plan(`${DROPS}.mp4`).ok, false);
    assert.equal(plan(`${DROPS}/../data.db`).ok, false);
    assert.equal(plan(`${DROPS}/../composer-dropzone/a.mp4`).ok, false);
    assert.equal(plan(`${DROPS}/2026-10-19/../../../../etc/a.mp4`).ok, false);
  });
  it("refuses hidden entries such as the in-progress .partial folder", () => {
    assert.equal(plan(`${DROPS}/.partial/abc.mp4`).ok, false);
    assert.equal(plan(`${DROPS}/2026-10-19/.hidden.mp4`).ok, false);
  });
  it("refuses non-media files inside the drops folder", () => {
    assert.equal(plan(`${DROPS}/2026-10-19/notes.txt`).ok, false);
    assert.equal(plan(`${DROPS}/2026-10-19/archive.zip`).ok, false);
  });
  it("refuses Windows-style and UNC absolute paths on POSIX", () => {
    assert.equal(plan("C:\\drops\\a.mp4").ok, false);
    assert.equal(plan("\\\\server\\share\\a.mp4").ok, false);
    assert.equal(plan(`${DROPS}\\2026-10-19\\a.mp4`).ok, false);
  });
  it("is case-sensitive about the folder but not the extension", () => {
    assert.equal(plan(`${DROPS.toUpperCase()}/a.mp4`).ok, false);
    assert.ok(plan(`${DROPS}/2026-10-19/A.MP4`).ok);
  });
});
