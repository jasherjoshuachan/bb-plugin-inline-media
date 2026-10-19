// "Only one player plays at a time": a registry of mounted media elements.
// Starting one pauses every other registered element.

export interface Pausable {
  readonly paused: boolean;
  pause(): void;
}

export interface PlaybackRegistry {
  /** Track an element; returns the function that stops tracking it. */
  register(element: Pausable): () => void;
  /** Call when `element` starts playing: pauses all others that are playing. Returns how many were paused. */
  claim(element: Pausable): number;
  readonly size: number;
}

export function createPlaybackRegistry(): PlaybackRegistry {
  const elements = new Set<Pausable>();
  return {
    register(element) {
      elements.add(element);
      return () => {
        elements.delete(element);
      };
    },
    claim(element) {
      let paused = 0;
      for (const other of elements) {
        if (other === element || other.paused) continue;
        try {
          other.pause();
          paused += 1;
        } catch {
          // A detached element can throw; it can't be playing anyway.
        }
      }
      return paused;
    },
    get size() {
      return elements.size;
    },
  };
}
