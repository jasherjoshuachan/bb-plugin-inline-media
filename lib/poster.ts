// First-frame posters, drawn in the browser.
//
// A hidden, detached <video> (never attached to the page, muted, never
// played) loads the same preview URL with preload="metadata", seeks to
// min(1 s, duration / 10) and the frame is drawn to a canvas. Results are
// cached per URL in memory. Any failure (decode error, tainted canvas,
// timeout) quietly yields null and the player keeps its plain look.

const MAX_WIDTH = 640;
const TIMEOUT_MS = 15_000;
const MAX_ENTRIES = 200;

const cache = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

/** Where to grab the poster frame: min(1 s, duration / 10), or 0.1 s when the duration is unknown. */
export function posterTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0.1;
  return Math.min(1, duration / 10);
}

/** A cached poster for `url`: a data URL, null when capture failed, undefined when not tried yet. */
export function cachedPoster(url: string): string | null | undefined {
  return cache.get(url);
}

function remember(url: string, value: string | null): string | null {
  cache.set(url, value);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}

function grab(url: string, doc: Document): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const video = doc.createElement("video");
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        video.removeAttribute("src");
        video.load();
      } catch {
        // ignore
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.addEventListener("error", () => finish(null), { once: true });
    video.addEventListener(
      "loadedmetadata",
      () => {
        try {
          if (video.videoWidth === 0 || video.videoHeight === 0) {
            finish(null);
            return;
          }
          video.currentTime = posterTime(video.duration);
        } catch {
          finish(null);
        }
      },
      { once: true },
    );
    video.addEventListener(
      "seeked",
      () => {
        try {
          const scale = Math.min(1, MAX_WIDTH / video.videoWidth);
          const canvas = doc.createElement("canvas");
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext("2d");
          if (context === null) {
            finish(null);
            return;
          }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          // Throws for a tainted canvas (cross-origin without CORS).
          finish(canvas.toDataURL("image/jpeg", 0.75));
        } catch {
          finish(null);
        }
      },
      { once: true },
    );
    try {
      video.src = url;
    } catch {
      finish(null);
    }
  });
}

/** The first-frame poster for a video URL (cached). Never rejects. */
export function capturePoster(url: string, doc: Document = document): Promise<string | null> {
  const cached = cache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inFlight.get(url);
  if (pending !== undefined) return pending;
  const promise = grab(url, doc)
    .catch(() => null)
    .then((value) => remember(url, value))
    .finally(() => inFlight.delete(url));
  inFlight.set(url, promise);
  return promise;
}
