// Behavior tests for the mediaUrl RPC against bb's fake plugin host, with a
// real temporary workspace on disk so symlink and not-found checks run.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { createInlineMediaServer } from "../server.ts";

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
let home: string;

before(() => {
  base = realpathSync(mkdtempSync(path.join(existsSync("/tmp") ? "/tmp" : tmpdir(), "inline-media-test-")));
  workspace = path.join(base, "ws");
  storage = path.join(base, "thread-storage");
  outside = path.join(base, "outside");
  home = path.join(base, "home");
  for (const dir of [workspace, path.join(workspace, "out"), storage, outside, path.join(home, "Movies"), path.join(home, ".ssh"), path.join(home, ".claude-work")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(home, "Movies", "original.mp4"), Buffer.alloc(13));
  writeFileSync(path.join(home, "Movies", "sibling.mp4"), Buffer.alloc(1));
  writeFileSync(path.join(home, "top.mp4"), Buffer.alloc(1));
  writeFileSync(path.join(home, ".ssh", "key.mp4"), Buffer.alloc(1));
  writeFileSync(path.join(home, ".claude-work", "x.mp4"), Buffer.alloc(1));
  symlinkSync(path.join(home, ".ssh", "key.mp4"), path.join(home, "Movies", "sneaky.mp4"));
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

interface SetupOptions {
  settings?: Record<string, boolean | number>;
  environment?: unknown;
  /** Prompt history entries (bb.sdk.threads.promptHistory). */
  history?: unknown[];
  /** Messages by seq (bb.sdk.threads.message). */
  messages?: Record<number, unknown>;
  platform?: NodeJS.Platform;
  /** Use the default export (no test seams). */
  plain?: boolean;
}

async function setup(options: SetupOptions = {}) {
  const previews: PreviewCall[] = [];
  const revealed: string[] = [];
  const historyCalls: unknown[] = [];
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
        promptHistory: async (args: unknown) => {
          historyCalls.push(args);
          return options.history ?? [];
        },
        message: async ({ seq }: { seq: number }) => {
          const message = options.messages?.[seq];
          if (message === undefined) throw new Error("message not found");
          return { message, before: [], after: [] };
        },
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
  if (options.plain === true) {
    await plugin(bbProxy);
  } else {
    await createInlineMediaServer(bbProxy, {
      home,
      platform: options.platform ?? "darwin",
      revealFile: async (file) => {
        revealed.push(file);
      },
    });
  }
  const call = (input: Record<string, unknown>) =>
    harness.behavior.callRpc("mediaUrl", { threadId: THREAD, ...input }) as Promise<Record<string, unknown>>;
  const reveal = (input: Record<string, unknown>) =>
    harness.behavior.callRpc("reveal", { threadId: THREAD, ...input }) as Promise<Record<string, unknown>>;
  return { bb, harness, previews, call, reveal, revealed, historyCalls };
}

describe("mediaUrl: workspace files", () => {
  it("returns a preview URL for the file's folder, with name, size and target", async () => {
    const { call, previews } = await setup({ plain: true });
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
  it("says whether the file can be revealed in Finder", async () => {
    assert.equal((await (await setup()).call({ path: "out/demo.mp4" })).canReveal, true);
    assert.equal((await (await setup({ platform: "linux" })).call({ path: "out/demo.mp4" })).canReveal, false);
    const remote = await setup({ environment: { id: "env_r", path: "/remote/ws", hostId: "host-remote" } });
    assert.equal((await remote.call({ path: "out/demo.mp4" })).canReveal, false);
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
  it("refuses absolute paths that are neither drops, workspace files nor attachments", async () => {
    const { call, previews } = await setup();
    await assert.rejects(call({ path: path.join(outside, "secret.mp4") }), /relative to the workspace/);
    await assert.rejects(call({ path: path.join(home, "Movies", "original.mp4") }), /attached to a message/);
    assert.equal(previews.length, 0);
  });
  it("serves an absolute path inside the workspace as that workspace file", async () => {
    const { call, previews } = await setup();
    const result = await call({ path: path.join(workspace, "out", "demo.mp4") });
    assert.equal(result.kind, "ok");
    assert.deepEqual(result.target, { kind: "workspace", environmentId: "env_1", path: "out/demo.mp4" });
    assert.equal(previews[0]?.rootPath, path.join(workspace, "out"));
    // The symlink check still applies.
    await assert.rejects(call({ path: path.join(workspace, "out", "link.mp4") }), /outside the workspace/);
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

describe("mediaUrl: files attached by absolute path", () => {
  const attachedHistory = (file: string, hostId: string | undefined = HOST) => [
    { id: "p1", createdAt: 1, input: [{ type: "text", text: "look", mentions: [] }, { type: "localFile", path: file, name: path.basename(file), ...(hostId === undefined ? {} : { hostId }) }] },
  ];

  it("serves a file the user attached to a message in this thread", async () => {
    const file = path.join(home, "Movies", "original.mp4");
    const { call, previews, historyCalls } = await setup({ history: attachedHistory(file) });
    const result = await call({ path: file });
    assert.equal(result.kind, "ok");
    assert.equal(result.sizeBytes, 13);
    assert.equal(result.canReveal, true);
    assert.deepEqual(result.target, { kind: "host", hostId: HOST, path: file });
    assert.deepEqual(previews, [{ hostId: HOST, rootPath: path.dirname(file), ttlMs: 30 * 60 * 1000 }]);
    assert.deepEqual(historyCalls, [{ threadId: THREAD, limit: "500" }]);
  });
  it("requires that exact path: a sibling of an attachment is refused", async () => {
    const { call, previews } = await setup({ history: attachedHistory(path.join(home, "Movies", "original.mp4")) });
    await assert.rejects(call({ path: path.join(home, "Movies", "sibling.mp4") }), /attached to a message/);
    assert.equal(previews.length, 0);
  });
  it("requires the attachment's host to be this bb server's machine", async () => {
    const file = path.join(home, "Movies", "original.mp4");
    const { call } = await setup({ history: attachedHistory(file, "host-other") });
    await assert.rejects(call({ path: file }), /attached to a message/);
  });
  it("accepts an attachment of the referenced message (no host recorded there)", async () => {
    const file = path.join(home, "Movies", "original.mp4");
    const messages = {
      7: { threadId: THREAD, role: "user", text: "see", attachments: { localFilePaths: [file], localFileDetails: [{ path: file, name: "original.mp4", sizeBytes: 13 }] } },
    };
    const { call } = await setup({ messages });
    assert.equal((await call({ path: file, message: { seq: 7 } })).kind, "ok");
    // Without the message reference (and no prompt history entry) it's refused.
    await assert.rejects(call({ path: file }), /attached to a message/);
    // A message from another thread doesn't count.
    const other = await setup({ messages: { 7: { ...messages[7], threadId: "th_other" } } });
    await assert.rejects(other.call({ path: file, message: { seq: 7 } }), /attached to a message/);
  });
  it("never serves protected locations, even when attached", async () => {
    for (const file of [path.join(home, ".ssh", "key.mp4"), path.join(home, ".claude-work", "x.mp4")]) {
      const { call, previews } = await setup({ history: attachedHistory(file) });
      await assert.rejects(call({ path: file }), /protected location/, file);
      assert.equal(previews.length, 0);
    }
  });
  it("refuses an attached symlink that points into a protected location", async () => {
    const file = path.join(home, "Movies", "sneaky.mp4");
    const { call } = await setup({ history: attachedHistory(file) });
    await assert.rejects(call({ path: file }), /protected location/);
  });
  it("refuses a file directly in the home folder (its preview would cover the home folder)", async () => {
    const file = path.join(home, "top.mp4");
    const { call, previews } = await setup({ history: attachedHistory(file) });
    await assert.rejects(call({ path: file }), /private data/);
    assert.equal(previews.length, 0);
  });
  it("keeps the extension allowlist and reports a missing attachment as not-found", async () => {
    const pdf = path.join(home, "Movies", "report.pdf");
    const gone = path.join(home, "Movies", "deleted.mp4");
    const { call } = await setup({ history: [...attachedHistory(pdf), ...attachedHistory(gone)] });
    await assert.rejects(call({ path: pdf }), /media file/);
    assert.deepEqual(await call({ path: gone }), { kind: "not-found", name: "deleted.mp4" });
  });
  it("rejects malformed message references", async () => {
    const { harness } = await setup();
    for (const message of [{ seq: -1 }, { seq: 1.5 }, { seq: "1" }, { seq: 1, extra: true }]) {
      await assert.rejects(harness.behavior.callRpc("mediaUrl", { threadId: THREAD, path: "a.mp4", message }));
    }
  });
});

describe("reveal", () => {
  it("reveals a workspace file by its resolved absolute path", async () => {
    const { reveal, revealed } = await setup();
    assert.deepEqual(await reveal({ path: "out/demo.mp4" }), { ok: true });
    assert.deepEqual(revealed, [path.join(workspace, "out", "demo.mp4")]);
  });
  it("reveals thread storage files and attached files", async () => {
    const file = path.join(home, "Movies", "original.mp4");
    const { reveal, revealed } = await setup({
      history: [{ id: "p", createdAt: 1, input: [{ type: "localFile", path: file, hostId: HOST }] }],
    });
    await reveal({ path: "memo.m4a", source: "thread-storage" });
    await reveal({ path: file });
    assert.deepEqual(revealed, [path.join(storage, "memo.m4a"), file]);
  });
  it("uses the same confinement as mediaUrl", async () => {
    const { reveal, revealed } = await setup();
    for (const bad of ["../outside/secret.mp4", "out/link.mp4", path.join(outside, "secret.mp4"), path.join(home, ".ssh", "key.mp4"), "out/notes.txt", "https://e.com/a.mp4"]) {
      await assert.rejects(reveal({ path: bad }), Error, bad);
    }
    await assert.rejects(reveal({ path: "out/missing.mp4" }), /not found/);
    assert.deepEqual(revealed, []);
  });
  it("refuses files that aren't on this Mac", async () => {
    const remote = await setup({ environment: { id: "env_r", path: "/remote/ws", hostId: "host-remote" } });
    await assert.rejects(remote.reveal({ path: "out/demo.mp4" }), /only for files on the Mac/);
    const linux = await setup({ platform: "linux" });
    await assert.rejects(linux.reveal({ path: "out/demo.mp4" }), /only for files on the Mac/);
    assert.deepEqual([...remote.revealed, ...linux.revealed], []);
  });
});
