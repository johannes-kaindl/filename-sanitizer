import { describe, expect, it } from "vitest";
import { loadSettings, trySetPolicy } from "../src/core/settings";
import { DEFAULT_FILENAME_POLICY } from "../src/vendor/kit/filename-policy";
import { FilenameSanitizerSettingTab } from "../src/obsidian/settings-tab";
import type FilenameSanitizerPlugin from "../src/main";
import type { App } from "obsidian";
import "../src/i18n/strings";
import { makeFakeEl } from "./vendor/kit/obsidian-mock";

function makeTab(extra: Record<string, unknown> = {}) {
  let saved = 0;
  const device = { repairs: true, name: "M5", setRepairs(v: boolean) { this.repairs = v; }, setName(v: string) { this.name = v; } };
  const plugin = { settings: loadSettings(null), device, saveSettings: () => { saved++; return Promise.resolve(); }, engine: { scanNow: () => Promise.resolve() }, ...extra } as unknown as FilenameSanitizerPlugin;
  const app = { vault: { getConfig: () => true } } as unknown as App;
  const Tab = FilenameSanitizerSettingTab as unknown as new (app: App, plugin: FilenameSanitizerPlugin) => FilenameSanitizerSettingTab;
  const tab = new Tab(app, plugin);
  (tab as unknown as { containerEl: unknown }).containerEl = makeFakeEl();
  return { tab, plugin, saved: () => saved, device };
}

describe("trySetPolicy", () => {
  it("accepts a valid replacement", () => {
    const r = trySetPolicy(DEFAULT_FILENAME_POLICY, "hash", "+");
    expect(r.ok && r.policy.replacements.hash).toBe("+");
  });
  it("invalid replacement shows problem", () => {
    expect(trySetPolicy(DEFAULT_FILENAME_POLICY, "hash", "#")).toEqual({ ok: false, badChars: "#" });
    expect(trySetPolicy(DEFAULT_FILENAME_POLICY, "question", "a?b")).toEqual({ ok: false, badChars: "?" });
  });
  it("maxBytes only 0 or 32 to 255", () => {
    expect(trySetPolicy(DEFAULT_FILENAME_POLICY, "maxBytes", 10).ok).toBe(false);
    expect(trySetPolicy(DEFAULT_FILENAME_POLICY, "maxBytes", 100).ok).toBe(true);
    expect(trySetPolicy(DEFAULT_FILENAME_POLICY, "maxBytes", 0).ok).toBe(true);
    expect(trySetPolicy(DEFAULT_FILENAME_POLICY, "maxBytes", 300).ok).toBe(false);
  });
  it("an additional character that a replacement contains is refused", () => {
    expect(trySetPolicy(DEFAULT_FILENAME_POLICY, "extraChars", "-").ok).toBe(false);
    expect(trySetPolicy(DEFAULT_FILENAME_POLICY, "extraChars", "€").ok).toBe(true);
  });
  it("does not touch the input", () => {
    trySetPolicy(DEFAULT_FILENAME_POLICY, "hash", "+");
    expect(DEFAULT_FILENAME_POLICY.replacements.hash).toBe(" ");
  });
});

describe("settings tab", () => {
  it("help row comes first, then repair, exceptions, and three collapsible groups", () => {
    const defs = makeTab().tab.getSettingDefinitions() as unknown as { type?: string; heading?: string }[];
    expect(defs).toHaveLength(6);
    expect(defs[0].type).not.toBe("group");
    expect(defs.slice(1).map((d) => d.heading)).toEqual(["Repair", "Exceptions", "Replacements", "Log", "Advanced"]);
  });
  it("setControlValue stores toggles and saves", async () => {
    const { tab, plugin, saved } = makeTab();
    await tab.setControlValue("aliasOldName", false);
    await tab.setControlValue("showNotice", false);
    expect(plugin.settings.aliasOldName).toBe(false); expect(plugin.settings.showNotice).toBe(false); expect(saved()).toBe(2);
  });
  it("setControlValue ignores unknown keys", async () => {
    const { tab, saved } = makeTab();
    await tab.setControlValue("nope", 1); expect(saved()).toBe(0);
  });
  it("replacement change is saved when valid and refused with the bad characters when not", async () => {
    const { tab, plugin, saved } = makeTab();
    expect(await tab.setPolicyField("hash", "+")).toEqual({ ok: true });
    expect(plugin.settings.policy.replacements.hash).toBe("+"); expect(saved()).toBe(1);
    expect(await tab.setPolicyField("hash", "#")).toEqual({ ok: false, badChars: "#" });
    expect(plugin.settings.policy.replacements.hash).toBe("+"); expect(saved()).toBe(1);
  });
  it("device values go to the device, not to data.json", () => {
    const { tab, plugin, device } = makeTab();
    tab.setDeviceRepairs(false); tab.setDeviceName("Büro");
    expect(device.repairs).toBe(false); expect(device.name).toBe("Büro");
    expect(JSON.stringify(plugin.settings)).not.toContain("Büro");
  });
  it("numbers: invalid input is refused, valid is saved", async () => {
    const { tab, plugin } = makeTab();
    expect(await tab.setNumber("quietMs", "abc")).toBe(false);
    expect(await tab.setNumber("quietMs", "-4")).toBe(false);
    expect(await tab.setNumber("quietMs", "1500")).toBe(true);
    expect(plugin.settings.quietMs).toBe(1500);
    expect(await tab.setNumber("logKeepMonths", "0")).toBe(true);
  });
  it("frontmatter keys are split on commas and trimmed", async () => {
    const { tab, plugin } = makeTab();
    await tab.setControlValue("logFrontmatterKeys", " agent , model,, source ");
    expect(plugin.settings.logFrontmatterKeys).toEqual(["agent", "model", "source"]);
  });
});
