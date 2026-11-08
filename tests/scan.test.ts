import { describe, expect, it } from "vitest";
import { scanDecisions } from "../src/core/scan";
import { loadSettings } from "../src/core/settings";

describe("scanDecisions", () => {
  const entries = [{ path: "o:r/a?.md", isFolder: false }, { path: "o:r", isFolder: true }, { path: "ok.md", isFolder: false }, { path: "old: x.md", isFolder: false }];
  it("skips valid names, orders folders first, marks snapshot entries legacy", () => {
    const out = scanDecisions(entries, { settings: loadSettings(null), linkAuto: true, snapshot: new Set(["old: x.md"]), trigger: "start", targetState: () => "free", isBlocked: () => false });
    expect(out.map((o) => [o.entry.path, o.decision.kind])).toEqual([["o:r", "rename"], ["old: x.md", "review"], ["o:r/a?.md", "rename"]]);
  });
  it("is empty for a clean vault", () => {
    expect(scanDecisions([{ path: "ok.md", isFolder: false }], { settings: loadSettings(null), linkAuto: true, snapshot: new Set(), trigger: "start", targetState: () => "free", isBlocked: () => false })).toEqual([]);
  });
});
