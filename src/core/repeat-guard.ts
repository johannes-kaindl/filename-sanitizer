/** Wiederholungsschutz: höchstens `limit` Reparaturen desselben Quellpfads in `windowMs`. */
export function createRepeatGuard(opts: { limit: number; windowMs: number; now(): number }): { record(path: string): boolean; isBlocked(path: string): boolean } {
  const seen = new Map<string, number[]>();
  const recent = (path: string): number[] => {
    const cutoff = opts.now() - opts.windowMs;
    const list = (seen.get(path) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) seen.delete(path); else seen.set(path, list);
    return list;
  };
  return {
    isBlocked: (path) => recent(path).length >= opts.limit,
    /** true: Reparatur erlaubt und gezählt; false: Grenze erreicht, nichts gezählt. */
    record(path) {
      const list = recent(path);
      if (list.length >= opts.limit) return false;
      list.push(opts.now());
      seen.set(path, list);
      return true;
    },
  };
}
