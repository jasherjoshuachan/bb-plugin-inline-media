import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cachedPoster, capturePoster, posterTime } from "../lib/poster.ts";
import { createMountStore } from "../lib/mount-store.ts";

describe("posterTime", () => {
  it("is min(1 s, duration / 10)", () => {
    assert.equal(posterTime(60), 1);
    assert.equal(posterTime(5), 0.5);
    assert.equal(posterTime(0.4), 0.04);
  });
  it("falls back for unknown durations", () => {
    assert.equal(posterTime(Number.NaN), 0.1);
    assert.equal(posterTime(Number.POSITIVE_INFINITY), 0.1);
    assert.equal(posterTime(0), 0.1);
  });
});

/** A tiny stand-in for the browser's <video> and <canvas>. */
function fakeDocument(options: { width: number; height: number; duration: number; taint?: boolean; fail?: boolean }) {
  const stats = { videos: 0, seekTo: [] as number[], muted: [] as boolean[], played: 0 };
  const doc = {
    createElement(tag: string) {
      if (tag === "canvas") {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: () => undefined }),
          toDataURL: () => {
            if (options.taint) throw new Error("SecurityError: tainted");
            return "data:image/jpeg;base64,AAAA";
          },
        };
      }
      stats.videos += 1;
      const listeners = new Map<string, () => void>();
      const video = {
        muted: false,
        preload: "",
        playsInline: false,
        videoWidth: options.width,
        videoHeight: options.height,
        duration: options.duration,
        set currentTime(value: number) {
          stats.seekTo.push(value);
          queueMicrotask(() => listeners.get("seeked")?.());
        },
        set src(_value: string) {
          stats.muted.push(video.muted);
          queueMicrotask(() => listeners.get(options.fail ? "error" : "loadedmetadata")?.());
        },
        addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
        removeAttribute: () => undefined,
        load: () => undefined,
        play: () => {
          stats.played += 1;
        },
      };
      return video;
    },
  };
  return { doc: doc as unknown as Document, stats };
}

describe("capturePoster", () => {
  it("seeks a hidden muted copy to the poster time and caches the frame per URL", async () => {
    const { doc, stats } = fakeDocument({ width: 1920, height: 1080, duration: 30 });
    assert.equal(cachedPoster("/preview/a/1.mp4"), undefined);
    const frame = await capturePoster("/preview/a/1.mp4", doc);
    assert.equal(frame, "data:image/jpeg;base64,AAAA");
    assert.deepEqual(stats.seekTo, [1]);
    assert.deepEqual(stats.muted, [true]);
    assert.equal(stats.played, 0);
    assert.equal(cachedPoster("/preview/a/1.mp4"), frame);
    await capturePoster("/preview/a/1.mp4", doc);
    assert.equal(stats.videos, 1);
  });
  it("yields null (and caches it) for a tainted canvas, a decode error or no picture", async () => {
    assert.equal(await capturePoster("/preview/b/taint.mp4", fakeDocument({ width: 10, height: 10, duration: 5, taint: true }).doc), null);
    assert.equal(await capturePoster("/preview/b/error.mp4", fakeDocument({ width: 10, height: 10, duration: 5, fail: true }).doc), null);
    assert.equal(await capturePoster("/preview/b/audio-only.mp4", fakeDocument({ width: 0, height: 0, duration: 5 }).doc), null);
    assert.equal(cachedPoster("/preview/b/taint.mp4"), null);
  });
});

describe("mount store", () => {
  it("adds, replaces per container, removes and notifies", () => {
    const store = createMountStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const a = {} as HTMLElement;
    const b = {} as HTMLElement;
    const request = { threadId: "t", file: "/x/a.mp4", name: "a.mp4", kind: "video" as const, messageSeq: null };
    store.add(a, request);
    store.add(b, request);
    const before = store.list();
    store.add(a, { ...request, file: "/x/c.mp4" });
    assert.notEqual(store.list(), before);
    assert.deepEqual(store.list().map((m) => m.request.file), ["/x/a.mp4", "/x/c.mp4"]);
    store.removeContainer(a);
    store.removeContainer(a);
    assert.equal(store.list().length, 1);
    store.clear();
    assert.equal(store.list().length, 0);
    assert.equal(calls, 5);
    unsubscribe();
    store.add(a, request);
    assert.equal(calls, 5);
  });
});
