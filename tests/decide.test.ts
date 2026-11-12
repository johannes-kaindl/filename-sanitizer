import { describe, expect, it } from "vitest";
import { decide, initialSnapshot, orderForRepair, targetFor, type TargetState, type Trigger } from "../src/core/decide";
import { loadSettings, type SanitizerSettings } from "../src/core/settings";
import { DEFAULT_FILENAME_POLICY } from "../src/vendor/kit/filename-policy";

const free = (): TargetState => "free";
function run(over: Partial<{ path: string; isFolder: boolean; settings: SanitizerSettings; linkAuto: boolean; inSnapshot: boolean; repeatBlocked: boolean; trigger: Trigger; targetState(t: string): TargetState }> = {}) {
  return decide({ path: "a: b.md", isFolder: false, settings: loadSettings(null), linkAuto: true, inSnapshot: false, repeatBlocked: false, trigger: "create", targetState: free, ...over });
}

describe("decide", () => {
  it("valid name is none", () => { expect(run({ path: "Ordner/ok.md" })).toEqual({ kind: "none" }); });
  it("exception wins, also in snapshot", () => {
    const settings = loadSettings({ exceptions: "Archiv/" });
    expect(run({ path: "Archiv/a: b.md", settings }).kind).toBe("exception");
    expect(run({ path: "Archiv/a: b.md", settings, inSnapshot: true, trigger: "start" }).kind).toBe("exception");
    expect(run({ path: "Archiv/ok.md", settings }).kind).toBe("none");
  });
  it("auto renames", () => {
    const d = run({ path: "Notes/vault-crews: Status.md" });
    expect(d).toMatchObject({ kind: "rename", target: "Notes/vault-crews — Status.md" });
    expect(d.kind === "rename" && d.hits.length).toBeGreaterThan(0);
  });
  it("review mode queues", () => { expect(run({ settings: loadSettings({ mode: "review" }) })).toMatchObject({ kind: "review", reason: "mode" }); });
  it("link setting off queues", () => { expect(run({ linkAuto: false, trigger: "create" })).toMatchObject({ kind: "review", reason: "link-setting" }); });
  it("list trigger with link setting off still queues", () => { expect(run({ linkAuto: false, trigger: "list" })).toMatchObject({ kind: "review", reason: "link-setting" }); });
  it("unknown extension renames like any other", () => { expect(run({ path: "a?.foo", linkAuto: true })).toMatchObject({ kind: "rename", target: "a.foo" }); });
  it("folder is not affected by extension rule", () => { expect(run({ path: "Ord:ner.foo", isFolder: true })).toMatchObject({ kind: "rename", target: "Ord-ner.foo" }); });
  it("snapshot entry is legacy, also at start", () => {
    expect(run({ inSnapshot: true, trigger: "start" })).toMatchObject({ kind: "review", reason: "legacy" });
    expect(run({ inSnapshot: true, trigger: "modify" })).toMatchObject({ kind: "review", reason: "legacy" });
  });
  it("second desktop first start renames nothing", () => {
    const paths = [{ path: "a: b.md", isFolder: false }, { path: "x/c?.md", isFolder: false }, { path: "o:r", isFolder: true }, { path: "ok.md", isFolder: false }];
    const snap = new Set(initialSnapshot(paths, DEFAULT_FILENAME_POLICY));
    expect([...snap].sort()).toEqual(["a: b.md", "o:r", "x/c?.md"]);
    for (const p of paths) expect(run({ ...p, inSnapshot: snap.has(p.path), trigger: "start" }).kind).not.toBe("rename");
  });
  it("new file after snapshot renames", () => { expect(run({ inSnapshot: false, trigger: "start" }).kind).toBe("rename"); });
  it("list trigger renames legacy entry", () => { expect(run({ inSnapshot: true, trigger: "list" }).kind).toBe("rename"); });
  it("list trigger renames in review mode", () => { expect(run({ settings: loadSettings({ mode: "review" }), trigger: "list" }).kind).toBe("rename"); });
  it("repeat blocked queues", () => { expect(run({ repeatBlocked: true })).toMatchObject({ kind: "review", reason: "repeat" }); });
  it("same content gives identical", () => { expect(run({ targetState: () => "same-content" })).toEqual({ kind: "identical", target: "a — b.md" }); });
  it("different content numbers, skipping taken numbers", () => {
    const taken = new Set(["a — b.md", "a — b 2.md"]);
    expect(run({ targetState: (t) => (taken.has(t) ? "different" : "free") })).toMatchObject({ kind: "rename", target: "a — b 3.md" });
  });
  it("reports how many names were taken while numbering, and nothing when the first is free", () => {
    const taken = new Set(["a — b.md", "a — b 2.md"]);
    expect(run({ targetState: (t) => (taken.has(t) ? "different" : "free") })).toMatchObject({ target: "a — b 3.md", collisions: 2 });
    expect(run({})).not.toHaveProperty("collisions");
  });
  it("folder target exists numbers, never merges", () => {
    const d = run({ path: "Ord:ner", isFolder: true, targetState: (t) => (t === "Ord-ner" ? "folder-exists" : "free") });
    expect(d).toMatchObject({ kind: "rename", target: "Ord-ner 2" });
  });
  it("numbered candidate with same content is identical", () => {
    const d = run({ targetState: (t) => (t === "a — b.md" ? "different" : t === "a — b 2.md" ? "same-content" : "free") });
    expect(d).toEqual({ kind: "identical", target: "a — b 2.md" });
  });
  it("name of only bad chars becomes Untitled, never empty", () => {
    const d = run({ path: "x/???.md" });
    expect(d).toMatchObject({ kind: "rename", target: "x/Untitled.md" });
  });
});

describe("helpers", () => {
  it("targetFor keeps the folder", () => { expect(targetFor("a/b/c: d.md", "c — d.md")).toBe("a/b/c — d.md"); expect(targetFor("c: d.md", "x.md")).toBe("x.md"); });
  it("exceptions match ancestors, names at any depth and exact paths", () => {
    const isEx = (path: string, exceptions: string): boolean => run({ path, settings: loadSettings({ exceptions }) }).kind === "exception";
    expect(isEx("Archiv/sub/a: b.md", "Archiv/")).toBe(true);
    expect(isEx("x/Archiv/a: b.md", "Archiv")).toBe(true);
    expect(isEx("Notes/a: b.md", "Archiv/")).toBe(false);
    expect(isEx("Notes/a: b.md", "Notes/a: b.md")).toBe(true);
    expect(isEx("Notes/a: b.md", "")).toBe(false);
  });
  it("orderForRepair puts folders before contents, shallow before deep", () => {
    const items = [{ path: "o:r/a?.md", isFolder: false }, { path: "x.md", isFolder: false }, { path: "o:r", isFolder: true }, { path: "o:r/i:n", isFolder: true }];
    expect(orderForRepair(items).map((i) => i.path)).toEqual(["o:r", "x.md", "o:r/i:n", "o:r/a?.md"]);
  });
});
