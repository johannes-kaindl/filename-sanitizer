import { describe, expect, it, vi } from "vitest";
import { createQuietQueue, type Timers } from "../src/core/queue";
import { createRepeatGuard } from "../src/vendor/kit/repeat-guard";

/** Manuelle Uhr: setTimeout merkt sich Fälligkeit, advance(ms) feuert alles Fällige in Reihenfolge. */
function fakeClock() {
  let now = 0; let id = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout(fn, ms) { const h = ++id; pending.set(h, { at: now + ms, fn }); return h; },
    clearTimeout(h) { pending.delete(h as number); },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const next = [...pending.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; pending.delete(next[0]); next[1].fn();
    }
    now = end;
  };
  return { timers, advance, now: () => now, count: () => pending.size };
}

describe("quiet queue", () => {
  it("fires after quiet", () => {
    const c = fakeClock(); const due = vi.fn();
    const q = createQuietQueue({ quietMs: 5000, timers: c.timers, onDue: due });
    q.touch("a.md"); c.advance(4999); expect(due).not.toHaveBeenCalled();
    c.advance(1); expect(due).toHaveBeenCalledWith("a.md"); expect(due).toHaveBeenCalledTimes(1);
  });
  it("touch restarts the wait", () => {
    const c = fakeClock(); const due = vi.fn();
    const q = createQuietQueue({ quietMs: 5000, timers: c.timers, onDue: due });
    q.touch("a.md"); c.advance(3000); q.touch("a.md"); c.advance(3000); q.touch("a.md");
    c.advance(4999); expect(due).not.toHaveBeenCalled();
    c.advance(1); expect(c.now()).toBe(11000); expect(due).toHaveBeenCalledTimes(1);
  });
  it("paths wait independently", () => {
    const c = fakeClock(); const due = vi.fn();
    const q = createQuietQueue({ quietMs: 1000, timers: c.timers, onDue: due });
    q.touch("a.md"); c.advance(500); q.touch("b.md"); c.advance(500);
    expect(due.mock.calls.map((x) => x[0])).toEqual(["a.md"]);
    c.advance(500); expect(due.mock.calls.map((x) => x[0])).toEqual(["a.md", "b.md"]);
  });
  it("forget cancels", () => {
    const c = fakeClock(); const due = vi.fn();
    const q = createQuietQueue({ quietMs: 1000, timers: c.timers, onDue: due });
    q.touch("a.md"); q.forget("a.md"); c.advance(5000); expect(due).not.toHaveBeenCalled();
  });
  it("dispose clears timers", () => {
    const c = fakeClock(); const due = vi.fn();
    const q = createQuietQueue({ quietMs: 1000, timers: c.timers, onDue: due });
    q.touch("a.md"); q.touch("b.md"); q.dispose(); expect(c.count()).toBe(0); c.advance(5000); expect(due).not.toHaveBeenCalled();
  });
  it("touch after dispose does nothing", () => {
    const c = fakeClock(); const due = vi.fn();
    const q = createQuietQueue({ quietMs: 1000, timers: c.timers, onDue: due });
    q.dispose(); q.touch("a.md"); expect(c.count()).toBe(0);
  });
});

describe("repeat guard", () => {
  it("blocks after limit", () => {
    let t = 0; const g = createRepeatGuard({ limit: 3, windowMs: 600000, now: () => t });
    expect([g.record("a: b.md"), g.record("a: b.md"), g.record("a: b.md")]).toEqual([true, true, true]);
    expect(g.isBlocked("a: b.md")).toBe(true);
    expect(g.record("a: b.md")).toBe(false);
    expect(g.isBlocked("other.md")).toBe(false);
  });
  it("is not blocked before the limit is reached", () => {
    const g = createRepeatGuard({ limit: 3, windowMs: 600000, now: () => 0 });
    g.record("x"); g.record("x"); expect(g.isBlocked("x")).toBe(false);
  });
  it("window expires", () => {
    let t = 0; const g = createRepeatGuard({ limit: 3, windowMs: 600000, now: () => t });
    g.record("x"); g.record("x"); g.record("x"); expect(g.isBlocked("x")).toBe(true);
    t = 600001; expect(g.isBlocked("x")).toBe(false); expect(g.record("x")).toBe(true);
  });
  it("recreated file stops after three repairs", () => {
    const c = fakeClock(); const guard = createRepeatGuard({ limit: 3, windowMs: 600000, now: c.now });
    const repaired: string[] = []; const refused: string[] = [];
    const q = createQuietQueue({ quietMs: 5000, timers: c.timers, onDue: (p) => { if (guard.record(p)) repaired.push(p); else refused.push(p); } });
    for (let i = 0; i < 4; i++) { q.touch("a: b.md"); c.advance(6000); }
    expect(repaired).toHaveLength(3); expect(refused).toEqual(["a: b.md"]);
  });
});
