import { Platform } from "obsidian";
import type { App } from "obsidian";
import type { DeviceState } from "./engine";

export const KEY_REPAIRS = "filename-sanitizer-repairs";
export const KEY_NAME = "filename-sanitizer-name";
export const KEY_SNAPSHOT = "filename-sanitizer-snapshot";

/** Geräteeigene Werte: nur im lokalen Speicher von Obsidian, nie in `data.json` (sie wird mitsynchronisiert). */
export function createDeviceState(app: App, random: () => number = Math.random): DeviceState & { setRepairs(on: boolean): void; setName(name: string): void } {
  const read = (key: string): unknown => { try { return app.loadLocalStorage(key); } catch { return null; } };
  const write = (key: string, value: unknown): void => { try { app.saveLocalStorage(key, value); } catch { /* ohne Speicher bleibt der Vorgabewert */ } };
  const suffix = (): string => Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
  return {
    get repairs(): boolean {
      const v = read(KEY_REPAIRS);
      return typeof v === "boolean" ? v : !Platform.isMobile;
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
    setRepairs: (on) => { write(KEY_REPAIRS, on); },
    setName: (name) => { write(KEY_NAME, name.trim() === "" ? null : name.trim()); },
  };
}
