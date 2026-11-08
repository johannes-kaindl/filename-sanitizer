import { describe, expect, it } from "vitest";
import { Notice as RealNotice } from "obsidian";
import { Notice as MockNotice } from "./vendor/kit/obsidian-mock";

// Zur Laufzeit ist `obsidian` der Mock; die echten Typen kennen weder `instances` noch `noticeEl` ohne Warnung.
const Notice = RealNotice as unknown as typeof MockNotice;
import FilenameSanitizerPlugin from "../src/main";
import { isFilenameSanitizerApi } from "../src/vendor/kit/filename-sanitizer-source";
import { flush, makeFakeApp } from "./helpers/fake-app";

// Der vendorte Mock kennt nur `noticeEl`; echtes Obsidian hat `messageEl` (und `noticeEl` ist veraltet).
Object.defineProperty(Notice.prototype, "messageEl", { get(this: { noticeEl: unknown }) { return this.noticeEl; }, configurable: true });

async function load() {
  const fa = makeFakeApp();
  const store = new Map<string, unknown>();
  const adapter = { exists: () => Promise.resolve(true), mkdir: () => Promise.resolve(), append: () => Promise.resolve(), list: () => Promise.resolve({ files: [], folders: [] }), read: () => Promise.resolve(""), remove: () => Promise.resolve() };
  Object.assign(fa.app, { loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => { store.set(k, v); } });
  (fa.app.vault as unknown as { adapter: unknown }).adapter = adapter;
  const Ctor = FilenameSanitizerPlugin as unknown as new (app: unknown, manifest: unknown) => FilenameSanitizerPlugin;
  const plugin = new Ctor(fa.app, { id: "filename-sanitizer", name: "Filename Sanitizer", version: "0.1.0" });
  await plugin.onload();
  return { fa, plugin, store };
}

describe("FilenameSanitizerPlugin", () => {
  it("exposes the api and hooks the engine after layout", async () => {
    const { fa, plugin } = await load();
    expect(isFilenameSanitizerApi(plugin.api)).toBe(true);
    expect(fa.listenerCount()).toBe(0);
    fa.fireLayoutReady(); await flush();
    expect(fa.listenerCount()).toBeGreaterThan(0);
    plugin.onunload();
    expect(fa.listenerCount()).toBe(0);
  });
  it("api answers before layout is ready", async () => {
    const { plugin } = await load();
    expect(plugin.api.sanitizeName("a: b.md", { caller: "t" })).toMatchObject({ name: "a — b.md" });
  });
  it("saveSettings persists", async () => {
    const { plugin } = await load();
    plugin.settings.mode = "review"; await plugin.saveSettings();
    expect(await plugin.loadData()).toMatchObject({ mode: "review" });
  });
  it("a popup click opens the log, a warning popup does not register a click", async () => {
    const { plugin } = await load();
    let opened = 0; plugin.openLog = () => { opened++; };
    const call = (text: string, open: boolean): MockNotice => { const n = Notice.instances.length; (plugin as unknown as { notice(t: string, o: boolean): void }).notice(text, open); return Notice.instances[n]; };
    (call("x", true).noticeEl as { click(): void }).click();
    expect(opened).toBe(1);
    (call("y", false).noticeEl as { click(): void }).click();
    expect(opened).toBe(1);
  });
});
