// vendored from code-kit@0.64.0, src/ts/pure/repeat-guard.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
// Origin: `filename-sanitizer/src/core/repeat-guard.ts` (2026-11-09). Searched first: `naehte_suche.py` found no throttle,
// rate-limit or window counter in code-kit or obsidian-kit; `busy-guard` is a one-at-a-time flag and `run-slot` a slot lock,
// neither counts events over time.

/** A sliding-window counter per key: at most `limit` records of one key within `windowMs`, then it blocks.
 *
 *  The sanitizer's use: an automatic repair of a file name must stop when the file comes back with the same bad name again and
 *  again (a sync tool recreating it), so after `limit` repairs of one path within the window the next one is refused and goes to
 *  a review list instead. It fits anything that must not repeat endlessly: a retry per target, an auto-fix per file.
 *
 *  Rules:
 *  - A record counts for `windowMs` milliseconds. A record exactly `windowMs` old is outside the window (the cutoff is
 *    exclusive), so the block ends at `oldest + windowMs`, not one millisecond later.
 *  - {@link RepeatGuard.record} is check-and-count in one call: `true` = allowed and counted, `false` = limit reached and
 *    **nothing counted**, so a refused attempt never extends the block.
 *  - {@link RepeatGuard.isBlocked} only looks. Use it to decide, then `record` when you act.
 *  - Keys do not interact. `limit` 0 (or less) blocks every key from the start.
 *  - The clock is injected (`now`, milliseconds, any monotonic or wall source); the module reads no global time. It is read on
 *    every call, so a fake clock in a test moves the window.
 *  - A key's list is dropped when all its records expired and the key is looked at again. A key that is never looked at again
 *    stays in the map until the guard is dropped: for the keys of one session (paths touched in a vault) that is small, but do
 *    not feed it unbounded unique keys over days. */
export interface RepeatGuard {
  /** Allowed and counted (`true`), or limit reached with nothing counted (`false`). */
  record(key: string): boolean;
  /** `true` when `limit` or more records of `key` lie inside the window. No side effect on the count. */
  isBlocked(key: string): boolean;
}

export function createRepeatGuard(opts: { limit: number; windowMs: number; now(): number }): RepeatGuard {
  const seen = new Map<string, number[]>();
  const recent = (key: string): number[] => {
    const cutoff = opts.now() - opts.windowMs;
    const list = (seen.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) seen.delete(key); else seen.set(key, list);
    return list;
  };
  return {
    isBlocked: (key) => recent(key).length >= opts.limit,
    record(key) {
      const list = recent(key);
      if (list.length >= opts.limit) return false;
      list.push(opts.now());
      seen.set(key, list);
      return true;
    },
  };
}
