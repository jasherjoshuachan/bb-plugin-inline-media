// Players the link decorator asked for, waiting to be rendered by the React
// bridge (an app overlay that portals each one into its container, so the
// player keeps the plugin's React context: RPC, settings, navigation).

export interface InlineMountRequest {
  threadId: string;
  file: string;
  name: string;
  kind: "video" | "audio";
  messageSeq: number | null;
}

export interface InlineMount {
  id: number;
  container: HTMLElement;
  request: InlineMountRequest;
}

export interface MountStore {
  add(container: HTMLElement, request: InlineMountRequest): number;
  /** Remove the mount rendered into `container`. */
  removeContainer(container: HTMLElement): void;
  clear(): void;
  /** Stable snapshot; a new array after every change (for useSyncExternalStore). */
  list(): readonly InlineMount[];
  subscribe(listener: () => void): () => void;
}

export function createMountStore(): MountStore {
  let mounts: readonly InlineMount[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  function emit(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }
  return {
    add(container, request) {
      const id = next++;
      mounts = [...mounts.filter((mount) => mount.container !== container), { id, container, request }];
      emit();
      return id;
    },
    removeContainer(container) {
      const kept = mounts.filter((mount) => mount.container !== container);
      if (kept.length === mounts.length) return;
      mounts = kept;
      emit();
    },
    clear() {
      if (mounts.length === 0) return;
      mounts = [];
      emit();
    },
    list() {
      return mounts;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
