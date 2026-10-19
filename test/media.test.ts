import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBytes, formatDuration } from "../lib/format.ts";
import { baseName, extensionOf, isMediaPath, MEDIA_EXTENSIONS, mediaKindForPath, playerKindFor } from "../lib/media.ts";
import { createPlaybackRegistry } from "../lib/playback.ts";
import { createPreviewCache, previewCacheKey, type PreviewEntry } from "../lib/preview-cache.ts";

describe("media kind detection", () => {
  it("maps every video extension to video", () => {
    for (const ext of [".mp4", ".m4v", ".mov", ".webm", ".ogv"]) assert.equal(mediaKindForPath(`a${ext}`), "video", ext);
  });
  it("maps every audio extension to audio", () => {
    for (const ext of [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac"]) {
      assert.equal(mediaKindForPath(`a${ext}`), "audio", ext);
    }
  });
  it("has exactly the documented allowlist", () => {
    assert.equal(Object.keys(MEDIA_EXTENSIONS).length, 13);
  });
  it("is case-insensitive", () => {
    assert.equal(mediaKindForPath("CLIP.MP4"), "video");
    assert.equal(mediaKindForPath("Memo.M4a"), "audio");
  });
  it("uses the last segment and last dot", () => {
    assert.equal(mediaKindForPath("dir.mp4/notes.txt"), null);
    assert.equal(mediaKindForPath("dir\\clip.webm"), "video");
    assert.equal(mediaKindForPath("a.txt.mp3"), "audio");
    assert.equal(mediaKindForPath("a.mp3.txt"), null);
  });
  it("refuses non-media and edge cases", () => {
    for (const value of ["", "a", "a.", ".mp4", "a.mkv", "a.gif", "a.toString", "a.__proto__", "a.constructor", "a.hasOwnProperty"]) {
      assert.equal(mediaKindForPath(value), null, value);
      assert.equal(isMediaPath(value), false, value);
    }
  });
  it("extensionOf and baseName", () => {
    assert.equal(extensionOf("a/b/C.Mp4"), ".mp4");
    assert.equal(extensionOf(".bashrc"), "");
    assert.equal(baseName("a/b\\c.mp4"), "c.mp4");
  });
  it("playerKindFor", () => {
    assert.equal(playerKindFor("media", "a.mov"), "video");
    assert.equal(playerKindFor("media", "a.ogg"), "audio");
    assert.equal(playerKindFor("audio", "a.mp4"), "audio");
    assert.equal(playerKindFor("video", "a.wav"), "video");
    assert.equal(playerKindFor("video", "a.txt"), null);
  });
});

describe("format", () => {
  it("formatDuration", () => {
    assert.equal(formatDuration(0), "0:00");
    assert.equal(formatDuration(7.9), "0:07");
    assert.equal(formatDuration(83), "1:23");
    assert.equal(formatDuration(3723), "1:02:03");
    assert.equal(formatDuration(Infinity), null);
    assert.equal(formatDuration(Number.NaN), null);
    assert.equal(formatDuration(-1), null);
    assert.equal(formatDuration(null), null);
  });
  it("formatBytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
    assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GB");
    assert.equal(formatBytes(null), null);
    assert.equal(formatBytes(-5), null);
  });
});

describe("playback registry", () => {
  function fake() {
    return {
      paused: true,
      pauses: 0,
      pause() {
        this.paused = true;
        this.pauses += 1;
      },
    };
  }
  it("pauses every other playing element when one starts", () => {
    const registry = createPlaybackRegistry();
    const a = fake();
    const b = fake();
    const c = fake();
    registry.register(a);
    registry.register(b);
    registry.register(c);
    a.paused = false;
    b.paused = false;
    c.paused = false;
    assert.equal(registry.claim(c), 2);
    assert.equal(a.paused, true);
    assert.equal(b.paused, true);
    assert.equal(c.paused, false);
    assert.equal(c.pauses, 0);
  });
  it("skips already paused elements and forgets unregistered ones", () => {
    const registry = createPlaybackRegistry();
    const a = fake();
    const b = fake();
    const off = registry.register(a);
    registry.register(b);
    assert.equal(registry.claim(b), 0);
    assert.equal(a.pauses, 0);
    off();
    a.paused = false;
    assert.equal(registry.claim(b), 0);
    assert.equal(registry.size, 1);
  });
  it("survives an element whose pause throws", () => {
    const registry = createPlaybackRegistry();
    registry.register({
      paused: false,
      pause() {
        throw new Error("detached");
      },
    });
    const b = fake();
    registry.register(b);
    assert.doesNotThrow(() => registry.claim(b));
  });
});

describe("preview cache", () => {
  function setup(marginMs = 1000) {
    let clock = 0;
    let calls = 0;
    const cache = createPreviewCache({ marginMs, now: () => clock, maxEntries: 3 });
    const create = (ttl = 10_000) => async (): Promise<PreviewEntry> => {
      calls += 1;
      return { baseUrl: `/preview/${calls}/`, expiresAtMs: clock + ttl };
    };
    return {
      cache,
      create,
      tick: (ms: number) => {
        clock += ms;
      },
      calls: () => calls,
    };
  }
  it("reuses an entry until shortly before it expires", async () => {
    const t = setup();
    const first = await t.cache.obtain("k", t.create());
    t.tick(8_000);
    assert.deepEqual(await t.cache.obtain("k", t.create()), first);
    t.tick(1_500); // 9.5 s: inside the 1 s margin before the 10 s expiry
    const second = await t.cache.obtain("k", t.create());
    assert.notEqual(second.baseUrl, first.baseUrl);
    assert.equal(t.calls(), 2);
  });
  it("refresh bypasses the cache", async () => {
    const t = setup();
    await t.cache.obtain("k", t.create());
    await t.cache.obtain("k", t.create(), true);
    assert.equal(t.calls(), 2);
  });
  it("keeps separate entries per key", async () => {
    const t = setup();
    await t.cache.obtain(previewCacheKey("host-a", "/x"), t.create());
    await t.cache.obtain(previewCacheKey("host-b", "/x"), t.create());
    await t.cache.obtain(previewCacheKey(undefined, "/x"), t.create());
    assert.equal(t.calls(), 3);
    assert.notEqual(previewCacheKey("a", "b/c"), previewCacheKey("a/b", "c"));
  });
  it("shares one in-flight request", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.cache.obtain("k", t.create()), t.cache.obtain("k", t.create())]);
    assert.deepEqual(a, b);
    assert.equal(t.calls(), 1);
  });
  it("does not cache failures", async () => {
    const t = setup();
    await assert.rejects(
      t.cache.obtain("k", async () => {
        throw new Error("offline");
      }),
      /offline/,
    );
    await t.cache.obtain("k", t.create());
    assert.equal(t.calls(), 1);
  });
  it("rejects malformed previews", async () => {
    const t = setup();
    await assert.rejects(t.cache.obtain("k", async () => ({ baseUrl: 5, expiresAtMs: 1 }) as unknown as PreviewEntry));
    assert.equal(t.cache.size, 0);
  });
  it("is bounded", async () => {
    const t = setup();
    for (const key of ["a", "b", "c", "d", "e"]) await t.cache.obtain(key, t.create());
    assert.equal(t.cache.size, 3);
  });
  it("never caches a preview that is already too close to expiry", async () => {
    const t = setup(5_000);
    await t.cache.obtain("k", t.create(2_000));
    await t.cache.obtain("k", t.create(2_000));
    assert.equal(t.calls(), 2);
  });
});
