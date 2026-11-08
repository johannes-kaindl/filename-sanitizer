import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/core/api";
import { loadSettings } from "../src/core/settings";
import { isFilenameSanitizerApi, type SanitizeResult } from "../src/vendor/kit/filename-sanitizer-source";

function make(settingsRaw: unknown = null, logChange = vi.fn()) {
  return { api: createApi({ settings: () => loadSettings(settingsRaw), logChange }), logChange };
}

describe("plugin api v1", () => {
  it("sanitizeName applies user policy", () => {
    const { api } = make({ policy: { replacements: { "colon-space": " – " } } });
    expect(api.sanitizeName("a: b.md", { caller: "t" })).toMatchObject({ name: "a – b.md", changed: true });
  });
  it("kind folder treats the whole segment", () => {
    const { api } = make();
    expect(api.sanitizeName("Ord:ner.x", { caller: "t", kind: "folder" })).toMatchObject({ name: "Ord-ner.x" });
  });
  it("is synchronous", () => {
    const { api } = make();
    expect(api.sanitizeName("a: b.md", { caller: "t" })).not.toBeInstanceOf(Promise);
    expect(api.checkName("a: b.md")).not.toBeInstanceOf(Promise);
  });
  it("logs only when changed, with caller", () => {
    const { api, logChange } = make();
    api.sanitizeName("ok.md", { caller: "koda" });
    expect(logChange).not.toHaveBeenCalled();
    const r = api.sanitizeName("a: b.md", { caller: "koda" }) as SanitizeResult;
    expect(logChange).toHaveBeenCalledTimes(1);
    expect(logChange).toHaveBeenCalledWith("koda", "a: b.md", r);
  });
  it("empty caller is invalid-input", () => {
    const { api, logChange } = make();
    for (const caller of ["", "   "]) expect(api.sanitizeName("a: b.md", { caller })).toMatchObject({ error: "invalid-input" });
    expect(api.sanitizeName("a: b.md", {} as never)).toMatchObject({ error: "invalid-input" });
    expect(logChange).not.toHaveBeenCalled();
  });
  it("non string or empty name and bad kind are invalid-input", () => {
    const { api } = make();
    for (const n of [undefined, null, 5, {}, ""]) {
      expect(api.sanitizeName(n as never, { caller: "t" })).toMatchObject({ error: "invalid-input" });
      expect(api.checkName(n as never)).toMatchObject({ error: "invalid-input" });
    }
    expect(api.sanitizeName("a.md", { caller: "t", kind: "dir" as never })).toMatchObject({ error: "invalid-input" });
  });
  it("checkName does not log", () => {
    const { api, logChange } = make();
    expect(api.checkName("a: b.md")).toMatchObject({ valid: false });
    expect(api.checkName("ok.md")).toEqual({ valid: true, hits: [] });
    expect(logChange).not.toHaveBeenCalled();
  });
  it("logging failure still returns the name", () => {
    const { api } = make(null, vi.fn(() => { throw new Error("disk"); }));
    expect(api.sanitizeName("a: b.md", { caller: "t" })).toMatchObject({ name: "a — b.md" });
  });
  it("result passes isFilenameSanitizerApi", () => {
    expect(isFilenameSanitizerApi(make().api)).toBe(true);
  });
  it("reads settings fresh on each call", () => {
    let raw: unknown = null;
    const api = createApi({ settings: () => loadSettings(raw), logChange: vi.fn() });
    expect(api.sanitizeName("a#b.md", { caller: "t" })).toMatchObject({ name: "a b.md" });
    raw = { policy: { replacements: { hash: "+" } } };
    expect(api.sanitizeName("a#b.md", { caller: "t" })).toMatchObject({ name: "a+b.md" });
  });
});
