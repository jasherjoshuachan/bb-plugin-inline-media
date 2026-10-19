// Behavior tests for the mediaUrl RPC against bb's fake plugin host, with a
// real temporary workspace on disk so symlink and not-found checks run.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const HOST = "host-local";
const THREAD = "th_1";

interface PreviewCall {
  hostId?: string;
  rootPath: string;
  ttlMs?: number;
}

let base: string;
let workspace: string;
let storage: string;
let outside: string;

before(() => {
  base = realpathSync(mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : tmpdir(), "inline-media-test-")));
  workspace = path.join(base, "ws");
  storage = path.join(base, "thread-storage");
  outside = path.join(base, "outside");
  for (const dir of [workspace, path.join(workspace, "out"), storage, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(workspace, "out", "demo.mp4"), Buffer.alloc(2048));
  writeFileSync(path.join(workspace, "out", "My Clip #1.webm"), Buffer.alloc(10));
  writeFileSync(path.join(workspace, "top.mp3"), Buffer.alloc(5));
  writeFileSync(path.join(storage, "memo.m4a"), Buffer.alloc(7));
  writeFileSync(path.join(outside, "secret.mp4"), Buffer.alloc(3));
  symlinkSync(path.join(outside, "secret.mp4"), path.join(workspace, "out", "link.mp4"));
  symlinkSync(outside, path.join(workspace, "linked-dir"));
  mkdirSync(path.join(workspace, "folder.mp4"));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

async function setup(options: { settings?: Record<string, boolean | number>; environment?: unknown } = {}) {
  const previews: PreviewCall[] = [];
  let counter = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "inline-media",
    dataDir: path.join(base, "data"),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    sdk: {
      system: { config: async () => ({ primaryHostId: HOST }) },
      threads: {
        get: async () => ({
          id: THREAD,
          environment:
            options.environment === undefined
              ? { id: "env_1", path: workspace, hostId: HOST }
              : options.environment,
        }),
        storageLocation: async () => ({ hostId: HOST, storageRootPath: storage }),
      },
      files: {
        createPreview: async (args: PreviewCall) => {
          previews.push({ hostId: args.hostId, rootPath: args.rootPath, ttlMs: args.ttlMs });
          counter += 1;
          return { baseUrl: `/preview/p${counter}/`, expiresAtMs: Date.now() + (args.ttlMs ?? 0) };
        },
      },
    } as never,
  });
  // Place this plugin's database where bb would (<dataDir>/plugins/<id>/data.db)
  // so the drops folder is derived exactly as in production.
  const dbName = path.join(base, "data", "plugins", "inline-media", "data.db");
  const storageProxy = new Proxy(bb.storage, {
    get(target, key) {
      if (key === "database") return () => ({ name: dbName });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bbProxy = new Proxy(bb, {
    get(target, key) {
      if (key === "storage") return storageProxy;
      return Reflect.get(target, key, target);
    },
  });
  await plugin(bbProxy);
  const call = (input: Record<string, unknown>) =>
    harness.behavior.callRpc("mediaUrl", { threadId: THREAD, ...input }) as Promise<Record<string, unknown>>;
  return { bb, harness, previews, call };
}

describe("mediaUrl: workspace files", () => {
  it("returns a preview URL for the file's folder, with name, size and target", async () => {
    const { call, previews } = await setup();
    const result = await call({ path: "out/demo.mp4" });
    assert.equal(result.kind, "ok");
    assert.equal(result.url, "/preview/p1/demo.mp4");
    assert.equal(result.name, "demo.mp4");
    assert.equal(result.sizeBytes, 2048);
    assert.equal(result.mediaKind, "video");
    assert.deepEqual(result.target, { kind: "workspace", environmentId: "env_1", path: "out/demo.mp4" });
    assert.deepEqual(previews, [{ hostId: HOST, rootPath: path.join(workspace, "out"), ttlMs: 30 * 60 * 1000 }]);
  });
  it("encodes the file name", async () => {
    const { call } = await setup();
    const result = await call({ path: "out/My Clip #1.webm" });
    assert.equal(result.url, "/preview/p1/My%20Clip%20%231.webm");
  });
  it("serves top-level files from the workspace root", async () => {
    const { call, previews } = await setup();
    const result = await call({ path: "top.mp3" });
    assert.equal(result.mediaKind, "audio");
    assert.equal(previews[0]?.rootPath, workspace);
  });
  it("reuses the preview for the same folder and refreshes on request", async () => {
    const { call, previews } = await setup();
    await call({ path: "out/demo.mp4" });
    const second = await call({ path: "out/My Clip #1.webm" });
    assert.equal(previews.length, 1);
    assert.equal(second.url, "/preview/p1/My%20Clip%20%231.webm");
    const refreshed = await call({ path: "out/demo.mp4", refresh: true });
    assert.equal(previews.length, 2);
    assert.equal(refreshed.url, "/preview/p2/demo.mp4");
  });
  it("reports missing files and folders as not-found without minting a preview", async () => {
    const { call, previews } = await setup();
    assert.deepEqual(await call({ path: "out/missing.mp4" }), { kind: "not-found", name: "missing.mp4" });
    assert.deepEqual(await call({ path: "nope/missing.mp4" }), { kind: "not-found", name: "missing.mp4" });
    assert.deepEqual(await call({ path: "folder.mp4" }), { kind: "not-found", name: "folder.mp4" });
    assert.equal(previews.length, 0);
  });
  it("refuses a symlink that points outside the workspace", async () => {
    const { call, previews } = await setup();
    await assert.rejects(call({ path: "out/link.mp4" }), /outside the workspace/);
    await assert.rejects(call({ path: "linked-dir/secret.mp4" }), /outside the workspace/);
    assert.equal(previews.length, 0);
  });
  it("refuses traversal, URLs, home paths and non-media files", async () => {
    const { call, previews } = await setup();
    for (const bad of ["../outside/secret.mp4", "out/../../outside/secret.mp4", "https://e.com/a.mp4", "~/a.mp4", "out/notes.txt", "", "%2e%2e/outside/secret.mp4"]) {
      await assert.rejects(call({ path: bad }), Error, bad);
    }
    assert.equal(previews.length, 0);
  });
  it("refuses absolute paths outside the drops folder", async () => {
    const { call } = await setup();
    await assert.rejects(call({ path: path.join(outside, "secret.mp4") }), /relative to the workspace/);
    await assert.rejects(call({ path: path.join(workspace, "out", "demo.mp4") }), /relative to the workspace/);
  });
  it("explains a thread without a workspace", async () => {
    const { call } = await setup({ environment: null });
    await assert.rejects(call({ path: "out/demo.mp4" }), /no workspace/);
  });
  it("rejects unknown input fields and bad sources", async () => {
    const { harness } = await setup();
    await assert.rejects(harness.behavior.callRpc("mediaUrl", { threadId: THREAD, path: "a.mp4", hostId: "x" }));
    await assert.rejects(harness.behavior.callRpc("mediaUrl", { threadId: THREAD, path: "a.mp4", source: "host" }));
    await assert.rejects(harness.behavior.callRpc("mediaUrl", { threadId: "", path: "a.mp4" }));
  });
});

describe("mediaUrl: thread storage", () => {
  it("resolves against the thread storage root", async () => {
    const { call, previews } = await setup();
    const result = await call({ path: "memo.m4a", source: "thread-storage" });
    assert.equal(result.kind, "ok");
    assert.equal(result.sizeBytes, 7);
    assert.deepEqual(result.target, { kind: "thread-storage", threadId: THREAD, path: "memo.m4a" });
    assert.equal(previews[0]?.rootPath, storage);
  });
  it("does not fall back to the workspace", async () => {
    const { call } = await setup();
    assert.equal((await call({ path: "top.mp3", source: "thread-storage" })).kind, "not-found");
  });
});

describe("mediaUrl: Composer Dropzone drops", () => {
  function dropsFile(name: string): string {
    const dir = path.join(base, "data", "plugins", "composer-dropzone", "drops", "2026-10-19");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    writeFileSync(file, Buffer.alloc(11));
    return file;
  }

  it("serves a drop by absolute path when allowed", async () => {
    const { call, previews } = await setup();
    const file = dropsFile("1a2b3c4d-big.mov");
    const result = await call({ path: file });
    assert.equal(result.kind, "ok");
    assert.equal(result.sizeBytes, 11);
    assert.deepEqual(result.target, { kind: "host", hostId: HOST, path: file });
    assert.equal(previews[0]?.rootPath, path.dirname(file));
    assert.equal(previews[0]?.hostId, HOST);
  });
  it("refuses drops when allowDropzoneFolder is off", async () => {
    const { call } = await setup({ settings: { allowDropzoneFolder: false } });
    await assert.rejects(call({ path: dropsFile("x.mp4") }), /relative to the workspace/);
  });
  it("refuses non-media and hidden files in the drops folder", async () => {
    const { call } = await setup();
    await assert.rejects(call({ path: dropsFile("notes.txt") }));
    const partial = path.join(base, "data", "plugins", "composer-dropzone", "drops", ".partial", "u.mp4");
    await assert.rejects(call({ path: partial }));
  });
});
