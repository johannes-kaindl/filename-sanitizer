import { Platform } from "obsidian";
import type { App } from "obsidian";
import type { DeviceState } from "./engine";
import type { CollapsibleStorage } from "../vendor/kit-obsidian/collapsible";

export const KEY_REPAIRS = "filename-sanitizer-repairs";
export const KEY_NAME = "filename-sanitizer-name";
export const KEY_SNAPSHOT = "filename-sanitizer-snapshot";
export const KEY_POLICY = "filename-sanitizer-policy";
export const KEY_FOLD = "filename-sanitizer-fold-";

/** Geräteeigene Werte: nur im lokalen Speicher von Obsidian, nie in `data.json` (sie wird mitsynchronisiert). */
export function createDeviceState(app: App, random: () => number = Math.random): DeviceState & { setRepairs(on: boolean): void; setName(name: string): void } {
  const read = (key: string): unknown => { try { return app.loadLocalStorage(key); } catch { return null; } };
  const write = (key: string, value: unknown): void => { try { app.saveLocalStorage(key, value); } catch { /* ohne Speicher bleibt der Vorgabewert */ } };
  const suffix = (): string => Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
  return {
    get repairs(): boolean {
      const v = read(KEY_REPAIRS);
      // Als Text gespeichert: Obsidian verwirft `false` beim Speichern (gemessen 1.15.1), „aus“ ginge verloren und der Vorgabewert (am Desktop „an“) käme zurück. Ein früher gespeichertes `true` gilt weiter.
      return v === "off" ? false : v === "on" || v === true ? true : !Platform.isMobile;
    },
    get name(): string {
      const v = read(KEY_NAME);
      if (typeof v === "string" && v.trim() !== "") return v;
      const generated = `${Platform.isMobile ? "Mobile" : "Desktop"}-${suffix()}`;
      write(KEY_NAME, generated);
      return generated;
    },
    snapshot(): Set<string> {
      const v = read(KEY_SNAPSHOT);
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    },
    hasSnapshot: () => Array.isArray(read(KEY_SNAPSHOT)),
    saveSnapshot: (paths) => { write(KEY_SNAPSHOT, paths); },
    policyKey: () => { const v = read(KEY_POLICY); return typeof v === "string" ? v : null; },
    savePolicyKey: (key) => { write(KEY_POLICY, key); },
    setRepairs: (on) => { write(KEY_REPAIRS, on ? "on" : "off"); },
    setName: (name) => { write(KEY_NAME, name.trim() === "" ? null : name.trim()); },
  };
}

/** Auf- und Zuklappzustand der Einstellungsgruppen: eine Eigenschaft dieses Geräts und dieser Ansicht, darum im lokalen Speicher und nicht in `data.json`.
 *  Als Text gespeichert (`closed`/`open`), nicht als Boolean: ein `false` ließe sich von „nichts gespeichert“ nicht sicher unterscheiden. */
export function createFoldStorage(app: App): CollapsibleStorage {
  return {
    getCollapsed: (key) => { try { const v: unknown = app.loadLocalStorage(KEY_FOLD + key); return v === "closed" ? true : v === "open" ? false : undefined; } catch { return undefined; } },
    setCollapsed: (key, collapsed) => { try { app.saveLocalStorage(KEY_FOLD + key, collapsed ? "closed" : "open"); } catch { /* ohne Speicher gilt beim nächsten Öffnen die Vorgabe */ } },
  };
}
