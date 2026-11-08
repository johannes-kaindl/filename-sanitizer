import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import { RepairEngine, type DeviceState, type LogStore } from "../src/obsidian/engine";
import { loadSettings, type SanitizerSettings } from "../src/core/settings";
import { parseLogLine, type LogInput } from "../src/core/log-entry";
import { fakeClock, flush, makeFakeApp } from "./helpers/fake-app";

function setup(over: { settings?: Record<string, unknown>; snapshot?: string[] | null; repairs?: boolean; policyKey?: string | null } = {}) {
  const fa = makeFakeApp();
  const clock = fakeClock();
  const settings: SanitizerSettings = loadSettings(over.settings ?? {});
  let snap: Set<string> | null = over.snapshot ? new Set(over.snapshot) : null;
  const saved: string[][] = [];
  let policyKey: string | null = over.policyKey ?? null;
  const device: DeviceState = {
    repairs: over.repairs ?? true, name: "M5",
    snapshot: () => snap ?? new Set<string>(), hasSnapshot: () => snap !== null,
    saveSnapshot: (p) => { saved.push(p); snap = new Set(p); },
    policyKey: () => policyKey, savePolicyKey: (k) => { policyKey = k; },
  };
  const lines: string[] = [];
  const log: LogStore = { write: (l) => { lines.push(l); }, read: () => Promise.resolve([]), rotate: () => Promise.resolve() };
  const bursts: unknown[] = []; const repeats: string[] = []; const stalled: string[] = [];
  const engine = new RepairEngine(fa.app, {
    settings: () => settings, device, log, timers: clock.timers, now: clock.now,
    notify: (b) => { bursts.push(b); }, notifyRepeat: (p) => { repeats.push(p); }, notifyStalled: (p) => { stalled.push(p); },
  });
  const entries = (): LogInput[] => lines.map((l) => parseLogLine(l)!);
  const boot = async (): Promise<void> => { engine.start(); fa.fireLayoutReady(); await flush(); };
  const renames = (): string[] => fa.calls.filter((c) => c.startsWith("rename"));
  return { fa, clock, engine, device, policyKeyNow: () => policyKey, lines, entries, bursts, repeats, stalled, saved, boot, renames, settings };
}

describe("RepairEngine", () => {
  it("start waits for layout", async () => {
    const t = setup(); t.engine.start();
    expect(t.fa.listenerCount()).toBe(0);
    t.fa.fireLayoutReady(); await flush();
    expect(t.fa.listenerCount()).toBeGreaterThan(0);
  });

  it("create after quiet renames via fileManager", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.create("Notes/a: b.md");
    await t.clock.advance(4999); expect(t.renames()).toEqual([]);
    await t.clock.advance(1);
    expect(t.renames()).toEqual(["rename Notes/a: b.md -> Notes/a — b.md"]);
    expect(t.fa.files.has("Notes/a — b.md")).toBe(true);
    expect(t.entries().map((e) => e.event)).toEqual(["repariert"]);
    expect(t.entries()[0]).toMatchObject({ oldPath: "Notes/a: b.md", newPath: "Notes/a — b.md", trigger: "create", device: "M5", mode: "auto" });
  });

  it("device off does nothing but keeps api", async () => {
    const t = setup({ snapshot: [], repairs: false }); await t.boot();
    t.fa.create("a: b.md"); await t.clock.advance(20000);
    expect(t.renames()).toEqual([]); expect(t.lines).toEqual([]);
  });

  it("file gone during wait logs nothing", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.create("a: b.md"); await t.clock.advance(1000); t.fa.remove("a: b.md"); await t.clock.advance(20000);
    expect(t.renames()).toEqual([]); expect(t.lines).toEqual([]);
  });

  it("file renamed during wait is rechecked", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.create("a: b.md"); await t.clock.advance(1000);
    t.fa.renameExternal("a: b.md", "c: d.md"); await t.clock.advance(20000);
    expect(t.renames()).toEqual(["rename c: d.md -> c — d.md"]);
    t.fa.create("e: f.md"); await t.clock.advance(1000); t.fa.renameExternal("e: f.md", "ok.md"); await t.clock.advance(20000);
    expect(t.renames()).toHaveLength(1);
  });

  it("renames run one at a time", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    let running = 0; let max = 0;
    t.fa.renameImpl = async (f, target) => {
      running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 5));
      running--; t.fa.files.delete(f.path); f.path = target; t.fa.files.set(target, f);
    };
    for (const n of ["a: 1.md", "b: 2.md", "c: 3.md"]) t.fa.create(n);
    await t.clock.advance(6000); await new Promise((r) => setTimeout(r, 60)); await flush();
    expect(t.renames()).toHaveLength(3); expect(max).toBe(1);
  });

  it("rename that exceeds deadline logs fehlgeschlagen and stops the automatic run", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.renameImpl = () => new Promise<void>(() => undefined);
    t.fa.create("a: b.md"); t.fa.create("c: d.md");
    await t.clock.advance(5000); expect(t.renames()).toHaveLength(1);
    await t.clock.advance(10000);
    expect(t.entries().map((e) => e.event)).toEqual(["fehlgeschlagen"]);
    expect(t.stalled).toEqual(["a: b.md"]);
    expect(t.renames()).toHaveLength(1);
    expect(t.engine.pending().map((p) => [p.path, p.reason])).toEqual([["c: d.md", "stalled"]]);
    t.fa.create("e: f.md"); await t.clock.advance(20000); expect(t.renames()).toHaveLength(1);
    // nach einem Neustart wieder aktiv
    t.engine.stop(); t.fa.renameImpl = null; await t.boot();
    t.fa.create("g: h.md"); await t.clock.advance(6000);
    expect(t.fa.files.has("g — h.md")).toBe(true);
  });

  it("own rename event is ignored", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.create("a: b.md"); await t.clock.advance(10000);
    expect(t.renames()).toHaveLength(1); expect(t.clock.count()).toBe(0);
  });

  it("folder before contained file", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.addFolder("o:r");
    t.fa.create("o:r/a?.md"); t.fa.modify("o:r");
    await t.clock.advance(6000);
    expect(t.renames()[0]).toBe("rename o:r -> o-r");
    await t.clock.advance(6000);
    expect(t.fa.files.has("o-r/a.md")).toBe(true);
    expect(t.entries().map((e) => [e.event, e.oldPath, e.newPath])).toEqual([["repariert", "o:r", "o-r"], ["repariert", "o-r/a?.md", "o-r/a.md"]]);
  });

  describe("alias", () => {
    it("added after rename, not before", async () => {
      const t = setup({ snapshot: [] }); await t.boot();
      t.fa.create("a: b.md"); await t.clock.advance(6000);
      expect(t.fa.calls).toEqual(["rename a: b.md -> a — b.md", "frontmatter a — b.md"]);
      expect(t.fa.fm.get("a — b.md")).toEqual({ aliases: ["a: b"] });
      expect(t.entries()[0].effect?.aliasSet).toBe(true);
    });
    it("not added on failure", async () => {
      const t = setup({ snapshot: [] }); await t.boot();
      t.fa.renameImpl = () => Promise.reject(new Error("boom"));
      t.fa.create("a: b.md"); await t.clock.advance(6000);
      expect(t.fa.calls.some((c) => c.startsWith("frontmatter"))).toBe(false);
      expect(t.entries().map((e) => e.event)).toEqual(["fehlgeschlagen"]);
    });
    it("not duplicated", async () => {
      const t = setup({ snapshot: [] }); await t.boot();
      t.fa.fm.set("a: b.md", { aliases: ["a: b"] });
      t.fa.create("a: b.md"); await t.clock.advance(6000);
      expect(t.fa.fm.get("a — b.md")).toEqual({ aliases: ["a: b"] });
      expect(t.entries()[0].effect?.aliasSet).toBe(false);
    });
    it("skipped for non markdown", async () => {
      const t = setup({ snapshot: [] }); await t.boot();
      t.fa.create("a: b.png"); await t.clock.advance(6000);
      expect(t.fa.calls.some((c) => c.startsWith("frontmatter"))).toBe(false);
      expect(t.fa.files.has("a — b.png")).toBe(true);
    });
    it("skipped when switched off", async () => {
      const t = setup({ snapshot: [], settings: { aliasOldName: false } }); await t.boot();
      t.fa.create("a: b.md"); await t.clock.advance(6000);
      expect(t.fa.calls.some((c) => c.startsWith("frontmatter"))).toBe(false);
    });
    it("error is logged, rename stays", async () => {
      const t = setup({ snapshot: [] }); await t.boot();
      t.fa.frontmatterImpl = () => Promise.reject(new Error("yaml broke"));
      t.fa.create("a: b.md"); await t.clock.advance(6000);
      expect(t.fa.files.has("a — b.md")).toBe(true);
      expect(t.entries()[0]).toMatchObject({ event: "repariert", effect: { aliasSet: false } });
      expect(t.entries()[0].message).toContain("yaml broke");
    });
  });

  it("link setting off opens no rename", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.config.alwaysUpdateLinks = false;
    t.fa.create("a: b.md"); await t.clock.advance(20000);
    expect(t.renames()).toEqual([]);
    expect(t.engine.pending().map((p) => p.reason)).toEqual(["link-setting"]);
  });

  describe("Regeländerung macht Bestandsnamen ungültig", () => {
    const withTilde = (t: ReturnType<typeof setup>): void => { t.settings.policy = { ...t.settings.policy, extraChars: "~", extraReplacement: "-" }; };

    it("Start nach geänderter Richtlinie: neu betroffener Bestand geht in die Prüfliste, nicht in die Umbenennung", async () => {
      const t = setup({ snapshot: [], policyKey: "alt" }); t.fa.addFile("a~b.md");
      withTilde(t);
      await t.boot(); await t.clock.advance(20000);
      expect(t.renames()).toEqual([]);
      expect(t.engine.pending().map((p) => [p.path, p.reason])).toEqual([["a~b.md", "legacy"]]);
      expect(t.policyKeyNow()).not.toBe("alt");
    });

    it("Änderung im Betrieb: der Bestandsname bleibt auch bei einem späteren Ereignis unangetastet", async () => {
      const t = setup(); t.fa.addFile("a~b.md");
      await t.boot();
      withTilde(t);
      t.engine.policyChanged(); await flush();
      expect(t.engine.pending().map((p) => [p.path, p.reason])).toEqual([["a~b.md", "legacy"]]);
      t.fa.modify("a~b.md"); await t.clock.advance(20000);
      expect(t.renames()).toEqual([]);
      expect(t.engine.pending().map((p) => [p.path, p.reason])).toEqual([["a~b.md", "legacy"]]);
    });

    it("Gegenprobe: eine nach der Änderung neu angelegte Datei wird weiter repariert", async () => {
      const t = setup(); await t.boot();
      withTilde(t);
      t.engine.policyChanged();
      t.fa.create("c~d.md"); await t.clock.advance(20000);
      expect(t.fa.files.has("c-d.md")).toBe(true);
    });

    it("unveränderte Richtlinie: Start nimmt nichts zusätzlich in den Schnappschuss", async () => {
      const t = setup({ snapshot: [] }); t.fa.addFile("a: b.md");
      await t.boot();
      expect(t.fa.files.has("a — b.md")).toBe(true);
    });
  });

  it("jede Endung wird repariert, wenn alwaysUpdateLinks an ist", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.create("a: b.foo"); await t.clock.advance(20000);
    expect(t.fa.files.has("a — b.foo")).toBe(true);
    expect(t.engine.pending()).toEqual([]);
  });

  it("first start stores snapshot and renames nothing", async () => {
    const t = setup(); t.fa.addFile("a: b.md"); t.fa.addFile("ok.md");
    await t.boot(); await t.clock.advance(20000);
    expect(t.saved).toEqual([["a: b.md"]]); expect(t.renames()).toEqual([]);
    expect(t.engine.pending().map((p) => [p.path, p.reason])).toEqual([["a: b.md", "legacy"]]);
  });

  it("later start repairs paths outside snapshot", async () => {
    const t = setup({ snapshot: ["a: b.md"] }); t.fa.addFile("a: b.md"); t.fa.addFile("c: d.md");
    await t.boot();
    expect(t.fa.files.has("c — d.md")).toBe(true);
    expect(t.fa.files.has("a: b.md")).toBe(true);
    expect(t.engine.pending().map((p) => [p.path, p.reason])).toEqual([["a: b.md", "legacy"]]);
    expect(t.entries()[0].trigger).toBe("start");
  });

  it("applyReview renames ticked only, unticked stay pending", async () => {
    const t = setup(); t.fa.addFile("a: b.md"); t.fa.addFile("c: d.md");
    await t.boot();
    await t.engine.applyReview(["a: b.md"]);
    expect(t.fa.files.has("a — b.md")).toBe(true);
    expect(t.fa.files.has("c: d.md")).toBe(true);
    expect(t.engine.pending().map((p) => p.path)).toEqual(["c: d.md"]);
    expect(t.entries().at(-1)).toMatchObject({ event: "repariert", trigger: "list" });
  });

  it("applyReview does nothing when the device does not repair", async () => {
    const t = setup({ repairs: false }); t.fa.addFile("a: b.md");
    await t.boot(); await t.engine.applyReview(["a: b.md"]);
    expect(t.renames()).toEqual([]);
  });

  describe("collisions", () => {
    it("identical compares bytes", async () => {
      const t = setup({ snapshot: [] }); await t.boot();
      t.fa.addFile("a — b.md", "same");
      t.fa.create("a: b.md", "same"); await t.clock.advance(6000);
      expect(t.renames()).toEqual([]);
      expect(t.engine.pending().map((p) => [p.path, p.reason, p.target])).toEqual([["a: b.md", "identical", "a — b.md"]]);
      expect(t.entries().map((e) => e.event)).toEqual(["identisch"]);
    });
    it("different content gets a number, never overwrites", async () => {
      const t = setup({ snapshot: [] }); await t.boot();
      t.fa.addFile("a — b.md", "one");
      t.fa.create("a: b.md", "two"); await t.clock.advance(6000);
      expect(t.fa.files.has("a — b 2.md")).toBe(true);
      expect(t.fa.content.get("a — b.md")).toBe("one");
    });
    it("same size, different bytes is different", async () => {
      const t = setup({ snapshot: [] }); await t.boot();
      t.fa.addFile("a — b.md", "abcd");
      t.fa.create("a: b.md", "abce"); await t.clock.advance(6000);
      expect(t.fa.files.has("a — b 2.md")).toBe(true);
    });
  });

  it("recreated file stops after three repairs", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    for (let i = 0; i < 4; i++) { t.fa.create("a: b.md", `v${i}`); await t.clock.advance(6000); }
    expect(t.renames()).toHaveLength(3);
    expect(t.fa.files.has("a: b.md")).toBe(true);
    expect(t.engine.pending().map((p) => [p.path, p.reason])).toEqual([["a: b.md", "repeat"]]);
    expect(t.repeats).toEqual(["a: b.md"]);
    expect(t.entries().map((e) => e.event)).toEqual(["repariert", "repariert", "repariert", "wiederholt"]);
  });

  it("review mode collects everything", async () => {
    const t = setup({ snapshot: [], settings: { mode: "review" } }); await t.boot();
    t.fa.create("a: b.md"); await t.clock.advance(6000);
    expect(t.renames()).toEqual([]);
    expect(t.engine.pending().map((p) => p.reason)).toEqual(["mode"]);
    expect(t.entries().map((e) => e.event)).toEqual(["vorgemerkt"]);
    const cb = vi.fn(); t.engine.onChange(cb); await t.engine.applyReview(["a: b.md"]);
    expect(t.fa.files.has("a — b.md")).toBe(true); expect(cb).toHaveBeenCalled();
  });

  it("one popup per burst, with the single names when there is one", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.create("a: 1.md"); await t.clock.advance(10000);
    expect(t.bursts).toEqual([{ count: 1, single: { oldName: "a: 1.md", newName: "a — 1.md" } }]);
    t.fa.create("b: 1.md"); t.fa.create("c: 1.md"); t.fa.create("d: 1.md"); await t.clock.advance(10000);
    expect(t.bursts.at(-1)).toEqual({ count: 3 }); expect(t.bursts).toHaveLength(2);
  });

  it("no popup when switched off", async () => {
    const t = setup({ snapshot: [], settings: { showNotice: false } }); await t.boot();
    t.fa.create("a: 1.md"); await t.clock.advance(10000);
    expect(t.bursts).toEqual([]);
  });

  it("log carries origin and frontmatter", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.fm.set("a: b.md", { agent: "claude", other: 1 });
    t.fa.addFile("x.md"); // dummy
    const f = t.fa.create("a: b.md", "hello"); (f as TFile).stat.ctime = -2000;
    await t.clock.advance(6000);
    const e = t.entries()[0];
    expect(e.origin).toMatchObject({ size: 5 }); expect(e.origin?.secondsToRepair).toBeGreaterThanOrEqual(7);
    expect(e.frontmatter).toEqual({ agent: "claude" });
  });
});

describe("Gegenleser-Befunde", () => {
  it("file moved away while the content is compared is not pulled back", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.addFolder("A"); t.fa.addFolder("B");
    t.fa.addFile("A/x.md", "same");
    t.fa.create("A/x?.md", "same");
    t.fa.hooks.onReadBinary = (f) => { if (f.path === "A/x?.md") t.fa.renameExternal("A/x?.md", "B/x?.md"); };
    await t.clock.advance(6000);
    // Kein Umbenennen auf das alte Ziel; die weggezogene Datei wird an ihrem neuen Ort für sich repariert.
    expect(t.renames()).toEqual(["rename B/x?.md -> B/x.md"]);
    expect(t.fa.content.get("A/x.md")).toBe("same");
    expect(t.entries().filter((e) => e.event === "fehlgeschlagen")).toEqual([]);
  });

  it("target that appears between decision and rename is decided again", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.create("a: b.md", "mine");
    let first = true;
    t.fa.renameImpl = (f, target) => {
      if (first) { first = false; t.fa.addFile("a — b.md", "other"); return Promise.reject(new Error("Destination file already exists!")); }
      t.fa.renameImpl = null; return Promise.resolve().then(() => { t.fa.files.delete(f.path); f.path = target; t.fa.files.set(target, f); });
    };
    await t.clock.advance(6000); await t.clock.advance(6000);
    expect(t.fa.files.has("a — b 2.md")).toBe(true);
    expect(t.fa.files.has("a: b.md")).toBe(false);
    expect(t.entries().map((e) => e.event)).toEqual(["kollision", "repariert"]);
  });

  it("failures count for the repeat guard and stop the retries", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.renameImpl = () => Promise.reject(new Error("boom"));
    t.fa.create("a: b.md");
    for (let i = 0; i < 6; i++) await t.clock.advance(6000);
    expect(t.renames()).toHaveLength(3);
    expect(t.engine.pending().map((p) => p.reason)).toEqual(["repeat"]);
  });

  it("applyReview does not rename an unticked parent folder", async () => {
    const t = setup(); t.fa.addFolder("A:"); t.fa.addFile("A:/b?.md");
    await t.boot();
    await t.engine.applyReview(["A:/b?.md"]);
    expect(t.fa.files.has("A:")).toBe(true);
    expect(t.fa.files.has("A:/b.md")).toBe(true);
    expect(t.engine.pending().map((p) => p.path)).toEqual(["A:"]);
  });

  it("legacy children move with their folder and stay legacy", async () => {
    const t = setup(); t.fa.addFolder("X:"); t.fa.addFile("X:/b?.md");
    await t.boot();
    await t.engine.applyReview(["X:"]);
    await t.clock.advance(20000);
    expect(t.fa.files.has("X-")).toBe(true);
    expect(t.fa.files.has("X-/b?.md")).toBe(true);
    expect(t.engine.pending().map((p) => [p.path, p.reason])).toEqual([["X-/b?.md", "legacy"]]);
    expect(t.renames()).toEqual(["rename X: -> X-"]);
  });

  it("a folder renamed from outside keeps the snapshot of its legacy children", async () => {
    const t = setup({ snapshot: ["X:", "X:/b?.md"] }); t.fa.addFolder("X:"); t.fa.addFile("X:/b?.md");
    await t.boot();
    t.fa.renameExternal("X:", "X-");
    await t.clock.advance(20000);
    expect(t.fa.files.has("X-/b?.md")).toBe(true);
    expect(t.renames()).toEqual([]);
  });

  it("device off still fills the review list", async () => {
    const t = setup({ snapshot: [], repairs: false }); await t.boot();
    t.fa.create("a: b.md"); await t.clock.advance(20000);
    expect(t.renames()).toEqual([]);
    expect(t.engine.pending().map((p) => p.reason)).toEqual(["mode"]);
  });

  it("the start scan tells listeners once", async () => {
    const t = setup(); for (let i = 0; i < 5; i++) t.fa.addFile(`a: ${i}.md`);
    let calls = 0; t.engine.onChange(() => { calls++; });
    await t.boot();
    expect(t.engine.pending()).toHaveLength(5); expect(calls).toBe(1);
  });

  it("a target that differs only in case or unicode form counts as taken", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.addFolder("N"); t.fa.addFile("N/a — B.md", "other");
    t.fa.create("N/a: b.md", "mine"); await t.clock.advance(6000);
    expect(t.fa.files.has("N/a — b 2.md")).toBe(true);
    expect(t.fa.content.get("N/a — B.md")).toBe("other");
  });

  it("large files are not read for the duplicate check", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    t.fa.addFile("a — b.md", "x", { size: 60_000_000 });
    t.fa.create("a: b.md", "x"); (t.fa.files.get("a: b.md") as TFile).stat.size = 60_000_000;
    await t.clock.advance(6000);
    expect(t.fa.reads).toBe(0);
    expect(t.fa.files.has("a — b 2.md")).toBe(true);
  });

  it("the link-setting popup comes once", async () => {
    const t = setup({ snapshot: [] });
    let n = 0; (t.engine as unknown as { deps: { notifyLinkSetting?: () => void } }).deps.notifyLinkSetting = () => { n++; };
    await t.boot(); t.fa.config.alwaysUpdateLinks = false;
    t.fa.create("a: 1.md"); t.fa.create("b: 2.md"); await t.clock.advance(8000);
    expect(n).toBe(1);
  });

  it("a second repeat case is reported again after the first is cleared", async () => {
    const t = setup({ snapshot: [] }); await t.boot();
    for (let i = 0; i < 4; i++) { t.fa.create("a: b.md", `v${i}`); await t.clock.advance(6000); }
    expect(t.repeats).toHaveLength(1);
    t.fa.remove("a: b.md"); await flush();
    expect(t.engine.pending()).toEqual([]);
    await t.clock.advance(700000);
    for (let i = 0; i < 4; i++) { t.fa.create("a: b.md", `w${i}`); await t.clock.advance(6000); }
    expect(t.repeats).toHaveLength(2);
  });
});
