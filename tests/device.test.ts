import { describe, expect, it } from "vitest";
import { Platform } from "obsidian";
import type { App } from "obsidian";
import { createDeviceState, createFoldStorage } from "../src/obsidian/device";

function fakeApp() {
  const store = new Map<string, unknown>();
  return { store, app: { loadLocalStorage: (k: string) => store.get(k) ?? null, saveLocalStorage: (k: string, v: unknown) => { if (v === null) store.delete(k); else store.set(k, v); } } as unknown as App };
}

describe("device state", () => {
  it("repairs on desktop and off on mobile by default", () => {
    const f = fakeApp();
    (Platform as { isMobile: boolean }).isMobile = false;
    expect(createDeviceState(f.app).repairs).toBe(true);
    (Platform as { isMobile: boolean }).isMobile = true;
    expect(createDeviceState(f.app).repairs).toBe(false);
    (Platform as { isMobile: boolean }).isMobile = false;
  });
  it("explicit switch wins and is stored locally", () => {
    const f = fakeApp(); const d = createDeviceState(f.app);
    d.setRepairs(false); expect(d.repairs).toBe(false); expect(f.store.get("filename-sanitizer-repairs")).toBe(false);
  });
  it("name is generated once, kept, and can be set", () => {
    const f = fakeApp(); const d = createDeviceState(f.app, () => 0.5);
    expect(d.name).toBe("Desktop-8000"); expect(d.name).toBe("Desktop-8000");
    d.setName("  Büro "); expect(d.name).toBe("Büro");
    d.setName(""); expect(createDeviceState(f.app, () => 0.25).name).toBe("Desktop-4000");
  });
  it("policy key is stored locally and starts empty", () => {
    const f = fakeApp(); const d = createDeviceState(f.app);
    expect(d.policyKey()).toBeNull(); d.savePolicyKey("{}"); expect(d.policyKey()).toBe("{}"); expect(f.store.get("filename-sanitizer-policy")).toBe("{}");
  });
  it("snapshot roundtrips and distinguishes none from empty", () => {
    const f = fakeApp(); const d = createDeviceState(f.app);
    expect(d.hasSnapshot()).toBe(false);
    d.saveSnapshot([]); expect(d.hasSnapshot()).toBe(true); expect(d.snapshot().size).toBe(0);
    d.saveSnapshot(["a: b.md"]); expect([...d.snapshot()]).toEqual(["a: b.md"]);
  });
  it("fold state is stored per group on this device, and unknown groups report undefined", () => {
    const f = fakeApp(); const fold = createFoldStorage(f.app);
    expect(fold.getCollapsed("log")).toBeUndefined();
    fold.setCollapsed("log", false); fold.setCollapsed("advanced", true);
    expect(f.store.get("filename-sanitizer-fold-log")).toBe("open");
    expect(createFoldStorage(f.app).getCollapsed("log")).toBe(false);
    expect(createFoldStorage(f.app).getCollapsed("advanced")).toBe(true);
    expect(fold.getCollapsed("replacements")).toBeUndefined();
    f.store.set("filename-sanitizer-fold-log", false); // ein Boolean aus fremder Hand gilt als „nichts gespeichert“
    expect(fold.getCollapsed("log")).toBeUndefined();
  });
});
