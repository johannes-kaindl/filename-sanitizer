import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { createLogStore } from "../src/obsidian/log-store";
import { loadSettings } from "../src/core/settings";
import { toLogLine } from "../src/core/log-entry";

function fakeAdapter() {
  const files = new Map<string, string>(); const dirs = new Set<string>();
  const adapter = {
    exists: (p: string) => Promise.resolve(files.has(p) || dirs.has(p)),
    mkdir: (p: string) => { dirs.add(p); return Promise.resolve(); },
    append: (p: string, t: string) => { files.set(p, (files.get(p) ?? "") + t); return Promise.resolve(); },
    read: (p: string) => Promise.resolve(files.get(p) ?? ""),
    list: (d: string) => Promise.resolve({ files: [...files.keys()].filter((f) => f.startsWith(`${d}/`)), folders: [] }),
    remove: (p: string) => { files.delete(p); return Promise.resolve(); },
  };
  return { files, dirs, app: { vault: { adapter } } as unknown as App };
}
const T = Date.UTC(2026, 10, 15, 12);
const fields = loadSettings(null).logFields;
const line = (time: number, n: string) => toLogLine({ time, event: "repariert", oldPath: n, rules: [], trigger: "create", device: "M5", mode: "auto" }, fields);

describe("log store", () => {
  it("appends to the device month file and creates the folder path", async () => {
    const f = fakeAdapter();
    const s = createLogStore(f.app, { settings: () => loadSettings(null), deviceName: () => "M5" });
    s.write(line(T, "a"), T); s.write(line(T + 1, "b"), T + 1);
    const read = await s.read(10);
    expect(f.dirs).toEqual(new Set(["Filename Sanitizer", "Filename Sanitizer/Log"]));
    expect([...f.files.keys()]).toEqual(["Filename Sanitizer/Log/M5-2026-11.jsonl"]);
    expect(read.map((e) => e.oldPath)).toEqual(["b", "a"]);
  });
  it("read skips damaged lines and honours the limit", async () => {
    const f = fakeAdapter();
    const s = createLogStore(f.app, { settings: () => loadSettings(null), deviceName: () => "M5" });
    s.write("garbage", T); for (let i = 0; i < 5; i++) s.write(line(T + i, `p${i}`), T);
    const read = await s.read(3);
    expect(read.map((e) => e.oldPath)).toEqual(["p4", "p3", "p2"]);
  });
  it("write errors are reported, never thrown", async () => {
    const f = fakeAdapter(); const errors: unknown[] = [];
    (f.app.vault.adapter as unknown as { append: () => Promise<void> }).append = () => Promise.reject(new Error("disk"));
    const s = createLogStore(f.app, { settings: () => loadSettings(null), deviceName: () => "M5", onError: (e) => errors.push(e) });
    s.write(line(T, "a"), T); await s.read(1);
    expect(errors).toHaveLength(1);
  });
  it("rotate removes old months only", async () => {
    const f = fakeAdapter();
    f.files.set("Filename Sanitizer/Log/M5-2024-01.jsonl", "x"); f.files.set("Filename Sanitizer/Log/M5-2026-11.jsonl", "x"); f.files.set("Filename Sanitizer/Log/readme.md", "x");
    f.dirs.add("Filename Sanitizer/Log");
    await createLogStore(f.app, { settings: () => loadSettings(null), deviceName: () => "M5" }).rotate(T);
    expect([...f.files.keys()].sort()).toEqual(["Filename Sanitizer/Log/M5-2026-11.jsonl", "Filename Sanitizer/Log/readme.md"]);
  });
});
