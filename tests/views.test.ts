import { describe, expect, it } from "vitest";
import { applyGate, nameDiff, reviewItems } from "../src/core/review-view";
import { logFilterOptions, logRows } from "../src/core/log-view";
import { exceptionLine } from "../src/core/exceptions";
import { isException } from "../src/core/decide";
import type { ReviewEntry } from "../src/core/review-entry";
import type { LogInput } from "../src/core/log-entry";
import { t } from "../src/vendor/kit/i18n";
import "../src/i18n/strings";

const e = (path: string, over: Partial<ReviewEntry> = {}): ReviewEntry => ({ path, isFolder: false, target: path.replace(": ", " — "), reason: "legacy", hits: [], ...over });
const A = e("Notes/a: b.md"), B = e("c: d.md");

describe("review view model", () => {
  it("all ticked by default gives accepted", () => {
    const items = reviewItems([A, B], new Set([A.path, B.path]));
    expect(items.map((i) => [i.id, i.decision])).toEqual([[A.path, "accepted"], [B.path, "accepted"]]);
  });
  it("removed tick gives rejected, stays listed", () => {
    const items = reviewItems([A, B], new Set([A.path]));
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.id === B.path)?.decision).toBe("rejected");
  });
  it("shows the old and the new name as a redline and the folder as meta", () => {
    const [item] = reviewItems([A], new Set([A.path]));
    expect(item.segments.filter((s) => s.kind === "del").map((s) => s.text).join("")).toBe(":");
    expect(item.segments.map((s) => s.text).join("")).toContain("a");
    expect(item.when).toBe("Notes");
    expect(reviewItems([B], new Set())[0].when).toBe("/");
  });
  it("identical marked as duplicate, never ticked", () => {
    const d = e("a: b.md", { reason: "identical" });
    const [item] = reviewItems([d], new Set([d.path]));
    expect(item.author).toBe(t("review.reason.identical"));
    expect(item.decision).toBe("rejected");
  });
  it("nameDiff keeps equal ends and marks the middle", () => {
    expect(nameDiff("ab: cd.md", "ab — cd.md")).toEqual([
      { kind: "same", text: "ab" }, { kind: "del", text: ":" }, { kind: "ins", text: " —" }, { kind: "same", text: " cd.md" },
    ]);
    expect(nameDiff("same.md", "same.md")).toEqual([{ kind: "same", text: "same.md" }]);
  });
});

describe("apply gate", () => {
  const env = { deviceRepairs: true };
  it("passes the ticked paths in repair order, without identical entries", () => {
    const g = applyGate([A, e("o:r", { isFolder: true }), e("x: y.md", { reason: "identical" })], new Set([A.path, "o:r", "x: y.md"]), env);
    expect(g).toEqual({ ok: true, paths: ["o:r", A.path] });
  });
  it("link-setting reason locks apply", () => {
    expect(applyGate([e("a: b.md", { reason: "link-setting" })], new Set(["a: b.md"]), env)).toEqual({ ok: false, why: "link-setting" });
  });
  it("stalled reason locks apply", () => {
    expect(applyGate([e("a: b.md", { reason: "stalled" })], new Set(["a: b.md"]), env)).toEqual({ ok: false, why: "stalled" });
  });
  it("mobile off locks apply", () => {
    expect(applyGate([A], new Set([A.path]), { deviceRepairs: false })).toEqual({ ok: false, why: "device-off" });
  });
  it("nothing ticked is locked", () => {
    expect(applyGate([A], new Set(), env)).toEqual({ ok: false, why: "nothing" });
    expect(applyGate([], new Set(), env)).toEqual({ ok: false, why: "nothing" });
  });
  it("an unticked locked entry does not lock the others", () => {
    expect(applyGate([A, e("q: r.md", { reason: "link-setting" })], new Set([A.path]), env)).toEqual({ ok: true, paths: [A.path] });
  });
});

const L = (time: number, over: Partial<LogInput> = {}): LogInput => ({ time, event: "repariert", oldPath: "Notes/a: b.md", newPath: "Notes/a — b.md", rules: ["colon-space"], trigger: "create", device: "M5", mode: "auto", ...over });
describe("log view model", () => {
  const entries = [L(1), L(3, { device: "iPhone", oldPath: "Inbox/x?.md", newPath: "Inbox/x.md", event: "vorgemerkt" }), L(2, { oldPath: "Notes/sub/c: d.md" })];
  it("log newest first", () => { expect(logRows(entries, {}).map((r) => r.time)).toEqual([3, 2, 1]); });
  it("filter by device, folder, event", () => {
    expect(logRows(entries, { device: "iPhone" }).map((r) => r.time)).toEqual([3]);
    expect(logRows(entries, { folder: "Notes" }).map((r) => r.time)).toEqual([2, 1]);
    expect(logRows(entries, { folder: "Notes/sub" }).map((r) => r.time)).toEqual([2]);
    expect(logRows(entries, { folder: "Not" }).map((r) => r.time)).toEqual([]);
    expect(logRows(entries, { event: "vorgemerkt" }).map((r) => r.time)).toEqual([3]);
    expect(logRows(entries, { device: "M5", event: "vorgemerkt" })).toEqual([]);
  });
  it("empty states", () => {
    expect(logRows([], {})).toEqual([]);
    expect(reviewItems([], new Set())).toEqual([]);
    expect(logFilterOptions([])).toEqual({ devices: [], events: [] });
  });
  it("filter options list what is present", () => { expect(logFilterOptions(entries)).toEqual({ devices: ["iPhone", "M5"], events: ["repariert", "vorgemerkt"] }); });
});

describe("exceptionLine", () => {
  it("keeps exactly this path and nothing else", () => {
    for (const path of ["a: b.md", "Notes/a*b?.md", "#x.md", "!y.md", "Ord[1]/c.md"]) {
      const line = exceptionLine(path);
      expect(isException(path, line)).toBe(true);
      expect(isException(`other/${path}`, line)).toBe(false);
      expect(isException("zzz.md", line)).toBe(false);
    }
    expect(isException("Notes/aXbY.md", exceptionLine("Notes/a*b?.md"))).toBe(false);
  });
});
