export interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }

/** Ruhezeit je Pfad: `onDue` kommt erst, wenn `quietMs` lang kein `touch` für diesen Pfad kam. */
export function createQuietQueue(opts: { quietMs: number; timers: Timers; onDue(path: string): void }): { touch(path: string): void; forget(path: string): void; dispose(): void } {
  const waiting = new Map<string, unknown>();
  let disposed = false;
  const forget = (path: string): void => {
    const h = waiting.get(path);
    if (h !== undefined) { opts.timers.clearTimeout(h); waiting.delete(path); }
  };
  return {
    touch(path) {
      if (disposed) return;
      forget(path);
      waiting.set(path, opts.timers.setTimeout(() => { waiting.delete(path); opts.onDue(path); }, opts.quietMs));
    },
    forget,
    dispose() {
      disposed = true;
      for (const h of waiting.values()) opts.timers.clearTimeout(h);
      waiting.clear();
    },
  };
}
