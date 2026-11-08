import { describe, expect, it } from "vitest";
import { expiredLogFiles, logFileName, parseLogLine, summarizeBurst, toLogLine, type LogInput } from "../src/core/log-entry";
import { applyPolicy, DEFAULT_FILENAME_POLICY } from "../src/vendor/kit/filename-policy";
import type { LogFields } from "../src/core/settings";

const ALL: LogFields = { origin: true, effect: true, environment: true, frontmatter: true, content: true };
const NONE: LogFields = { origin: false, effect: false, environment: false, frontmatter: false, content: false };
const T = Date.UTC(2026, 10, 15, 12, 0, 0);
const full: LogInput = {
  time: T, event: "repariert", oldPath: "a: b.md", newPath: "a — b.md", rules: ["colon-space"], trigger: "create", caller: "koda-agent", device: "M5", mode: "auto",
  origin: { ctime: T - 6000, mtime: T - 5000, size: 12, secondsToRepair: 6, burstCount: 1 },
  effect: { aliasSet: true, linksChanged: 2 },
  environment: { pluginVersion: "0.1.0", obsidianVersion: "1.15.1", platform: "macOS" },
  frontmatter: { agent: "claude", model: "x" }, content: "# Hallo\nWelt", message: "ok",
};

describe("log line", () => {
  it("core fields always present, schema v 1", () => {
    const o = JSON.parse(toLogLine(full, NONE)) as Record<string, unknown>;
    expect(o.v).toBe(1);
    for (const k of ["time", "event", "oldPath", "newPath", "rules", "trigger", "caller", "device", "mode"]) expect(o).toHaveProperty(k);
    for (const k of ["origin", "effect", "environment", "frontmatter", "content"]) expect(o).not.toHaveProperty(k);
  });
  it.each([["origin"], ["effect"], ["environment"], ["frontmatter"], ["content"]] as const)("field group %s is dropped when off and kept when on", (g) => {
    const on = JSON.parse(toLogLine(full, { ...NONE, [g]: true })) as Record<string, unknown>;
    expect(on).toHaveProperty(g);
    const off = JSON.parse(toLogLine(full, { ...ALL, [g]: false })) as Record<string, unknown>;
    expect(off).not.toHaveProperty(g);
  });
  it("content off by default never written", () => {
    expect(toLogLine(full, { ...ALL, content: false })).not.toContain("Welt");
  });
  it("line has no newline, roundtrips", () => {
    const line = toLogLine(full, ALL);
    expect(line).not.toMatch(/[\r\n]/);
    expect(parseLogLine(line)).toEqual(full);
  });
  it("optional parts may be missing", () => {
    const min: LogInput = { time: T, event: "übersprungen", oldPath: "x", rules: [], trigger: "list", device: "d", mode: "review" };
    expect(parseLogLine(toLogLine(min, ALL))).toEqual(min);
  });
  it("damaged line parses to null", () => {
    for (const l of ["", "{", "[]", "null", '{"v":2,"time":"x"}', '{"v":1}', '{"v":1,"time":"nope","event":"repariert","oldPath":"a","rules":[],"trigger":"t","device":"d","mode":"auto"}', '{"v":1,"time":"2026-11-15T12:00:00.000Z","event":"unbekannt","oldPath":"a","rules":[],"trigger":"t","device":"d","mode":"auto"}']) expect(parseLogLine(l)).toBeNull();
  });
});

describe("log files", () => {
  it("logFileName per device and month, valid under the policy", () => {
    expect(logFileName("M5", T)).toBe("M5-2026-11.jsonl");
    const n = logFileName("a:b", T);
    expect(applyPolicy(n, DEFAULT_FILENAME_POLICY, "file").changed).toBe(false);
    expect(n.endsWith("-2026-11.jsonl")).toBe(true);
  });
  it("expiredLogFiles", () => {
    const now = T; // 2026-11
    const names = ["M5-2026-11.jsonl", "M5-2025-11.jsonl", "M5-2025-10.jsonl", "M5-2024-01.jsonl", "notes.md", "M5-2026-13.jsonl"];
    expect(expiredLogFiles(names, now, 12).sort()).toEqual(["M5-2024-01.jsonl", "M5-2025-10.jsonl"]);
    expect(expiredLogFiles(names, now, 0)).toEqual([]);
    expect(expiredLogFiles(names, now, 1).sort()).toEqual(["M5-2024-01.jsonl", "M5-2025-10.jsonl", "M5-2025-11.jsonl"]);
  });
  it("summarizeBurst", () => {
    const one = { oldName: "a: b.md", newName: "a — b.md" };
    expect(summarizeBurst([one])).toEqual({ count: 1, single: one });
    expect(summarizeBurst([one, one, one])).toEqual({ count: 3 });
    expect(summarizeBurst([])).toEqual({ count: 0 });
  });
});
