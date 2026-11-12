import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, checkNumber, loadSettings } from "../src/core/settings";
import { DEFAULT_FILENAME_POLICY, checkFolderPath, validatePolicy } from "../src/vendor/kit/filename-policy";

describe("settings", () => {
  it("defaults match the spec", () => {
    const s = loadSettings(null);
    expect(s.mode).toBe("auto");
    expect(s.aliasOldName).toBe(true);
    expect(s.showNotice).toBe(true);
    expect(s.quietMs).toBe(5000);
    expect(s.logFolder).toBe("Filename Sanitizer/Log");
    expect(s.logKeepMonths).toBe(12);
    expect(s.logFields).toEqual({ origin: true, effect: true, environment: true, frontmatter: true, content: false });
    expect(s.logFrontmatterKeys).toEqual(["agent", "model", "session_id", "created_by", "source"]);
    expect(s.policy).toEqual(DEFAULT_FILENAME_POLICY);
    expect(s.exceptions).toBe("");
  });
  it("invalid replacement falls back to default for that rule", () => {
    const s = loadSettings({ policy: { replacements: { hash: "#", question: "?!", star: "+" } } });
    expect(s.policy.replacements.hash).toBe(DEFAULT_FILENAME_POLICY.replacements.hash);
    expect(s.policy.replacements.question).toBe(DEFAULT_FILENAME_POLICY.replacements.question);
    expect(s.policy.replacements.star).toBe("+");
    expect(validatePolicy(s.policy)).toEqual([]);
  });
  it("invalid maxBytes falls back, valid is kept", () => {
    expect(loadSettings({ policy: { maxBytes: 10 } }).policy.maxBytes).toBe(0);
    expect(loadSettings({ policy: { maxBytes: 100 } }).policy.maxBytes).toBe(100);
  });
  it("extra char that clashes with a replacement leaves a usable policy", () => {
    const s = loadSettings({ policy: { extraChars: "-" } });
    expect(validatePolicy(s.policy)).toEqual([]);
  });
  it("non numeric quietMs falls back", () => {
    expect(loadSettings({ quietMs: "abc" }).quietMs).toBe(5000);
    expect(loadSettings({ quietMs: -5 }).quietMs).toBe(5000);
    expect(loadSettings({ quietMs: 1200 }).quietMs).toBe(1200);
  });
  it("garbage input gives defaults", () => {
    for (const raw of [undefined, 42, "x", [], { mode: "weird", logFields: 7, logFrontmatterKeys: "a", policy: 5, logKeepMonths: -3, logFolder: "  " }]) {
      expect(loadSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });
  it("valid values survive, defaults are not shared", () => {
    const s = loadSettings({ mode: "review", logFolder: "Log", logKeepMonths: 0, logFields: { content: true }, logFrontmatterKeys: ["a"], exceptions: "Archiv/" });
    expect(s.mode).toBe("review");
    expect(s.logFolder).toBe("Log");
    expect(s.logKeepMonths).toBe(0);
    expect(s.logFields.content).toBe(true);
    expect(s.logFields.origin).toBe(true);
    expect(s.logFrontmatterKeys).toEqual(["a"]);
    expect(s.exceptions).toBe("Archiv/");
    s.logFrontmatterKeys.push("z");
    expect(loadSettings(null).logFrontmatterKeys).toHaveLength(5);
  });

  describe("number ranges", () => {
    it("quietMs: 0 and absurd sizes fall back on load", () => {
      expect(loadSettings({ quietMs: 0 }).quietMs).toBe(5000);
      expect(loadSettings({ quietMs: 600001 }).quietMs).toBe(5000);
      expect(loadSettings({ quietMs: 1e15 }).quietMs).toBe(5000);
      expect(loadSettings({ quietMs: 1 }).quietMs).toBe(1);
      expect(loadSettings({ quietMs: 600000 }).quietMs).toBe(600000);
    });
    it("logKeepMonths 0 means unlimited and stays; logContentChars is capped", () => {
      expect(loadSettings({ logKeepMonths: 0 }).logKeepMonths).toBe(0);
      expect(loadSettings({ logKeepMonths: 1201 }).logKeepMonths).toBe(12);
      expect(loadSettings({ logContentChars: 2001 }).logContentChars).toBe(200);
      expect(loadSettings({ logContentChars: 2000 }).logContentChars).toBe(2000);
    });
    it("checkNumber refuses 0 for quietMs, huge digit strings and non-digits", () => {
      expect(checkNumber("quietMs", "0")).toEqual({ ok: false });
      expect(checkNumber("quietMs", "99999999999999999999999")).toEqual({ ok: false });
      expect(checkNumber("quietMs", "12a")).toEqual({ ok: false });
      expect(checkNumber("quietMs", " 1500 ")).toEqual({ ok: true, value: 1500 });
      expect(checkNumber("logKeepMonths", "0")).toEqual({ ok: true, value: 0 });
      expect(checkNumber("logKeepMonths", "1201")).toEqual({ ok: false });
    });
  });

  describe("log folder", () => {
    const p = DEFAULT_FILENAME_POLICY;
    it("accepts nested names and trims surrounding slashes", () => {
      expect(checkFolderPath(" Filename Sanitizer/Log ", p)).toEqual({ ok: true, folder: "Filename Sanitizer/Log" });
      expect(checkFolderPath("/Logs/fsan/", p)).toEqual({ ok: true, folder: "Logs/fsan" });
    });
    it("names the segment it refuses", () => {
      expect(checkFolderPath("a:b", p)).toEqual({ ok: false, bad: "a:b" });
      expect(checkFolderPath("Logs/bad?/x", p)).toEqual({ ok: false, bad: "bad?" });
      expect(checkFolderPath("Logs//x", p)).toEqual({ ok: false, bad: "Logs//x" });
      expect(checkFolderPath("../x", p)).toEqual({ ok: false, bad: ".." });
      expect(checkFolderPath("   ", p)).toEqual({ ok: false, bad: "" });
      expect(checkFolderPath(".hidden/log", p)).toEqual({ ok: false, bad: ".hidden" });
    });
    it("loadSettings replaces an invalid stored folder by the default", () => {
      expect(loadSettings({ logFolder: "a:b" }).logFolder).toBe(DEFAULT_SETTINGS.logFolder);
      expect(loadSettings({ logFolder: "Mine/Log" }).logFolder).toBe("Mine/Log");
    });
  });
});
