import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import type { Timers } from "../../src/core/queue";

/** Manuelle Uhr für Timer und `now()`. */
export function fakeClock() {
  let now = 0; let id = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout(fn, ms) { const h = ++id; pending.set(h, { at: now + ms, fn }); return h; },
    clearTimeout(h) { pending.delete(h as number); },
  };
  /** Rückt vor und lässt nach jedem Timer die Promises laufen. */
  const advance = async (ms: number): Promise<void> => {
    const end = now + ms;
    for (;;) {
      const next = [...pending.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; pending.delete(next[0]); next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  return { timers, advance, now: () => now, count: () => pending.size };
}

export const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };

/** Die Typen des echten `obsidian` kennen keinen Konstruktor-Parameter; zur Laufzeit ist es der Mock. */
const MockTFile = TFile as unknown as new (path: string) => TFile;
const MockTFolder = TFolder as unknown as new (path: string) => TFolder;

type Handler = (...a: unknown[]) => void;

export interface FakeApp {
  app: App;
  files: Map<string, TFile | TFolder>;
  content: Map<string, string>;
  fm: Map<string, Record<string, unknown>>;
  calls: string[];
  config: { alwaysUpdateLinks: boolean };
  layoutCallbacks: (() => void)[];
  /** Ersetzt das Umbenennen (Fehler, Hänger). */
  renameImpl: ((file: TFile | TFolder, target: string) => Promise<void>) | null;
  frontmatterImpl: ((file: TFile) => Promise<void>) | null;
  addFile(path: string, content?: string, stat?: Partial<TFile["stat"]>): TFile;
  addFolder(path: string): TFolder;
  create(path: string, content?: string): TFile;
  createFolder(path: string): TFolder;
  modify(path: string): void;
  remove(path: string): void;
  renameExternal(path: string, target: string): void;
  fireLayoutReady(): void;
  listenerCount(): number;
}

function parentOf(path: string): string { const i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); }

export function makeFakeApp(): FakeApp {
  const files = new Map<string, TFile | TFolder>();
  const content = new Map<string, string>();
  const fm = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Set<Handler>>();
  const calls: string[] = [];
  const layoutCallbacks: (() => void)[] = [];
  const config = { alwaysUpdateLinks: true };
  const emit = (name: string, ...a: unknown[]): void => { for (const h of [...(handlers.get(name) ?? [])]) h(...a); };

  const self: FakeApp = {
    files, content, fm, calls, config, layoutCallbacks, renameImpl: null, frontmatterImpl: null,
    app: null as unknown as App,
    addFile(path, text = "x", stat = {}) {
      const f = new MockTFile(path); f.stat = { ctime: 0, mtime: 0, size: text.length, ...stat }; files.set(path, f); content.set(path, text);
      const p = files.get(parentOf(path)); if (p instanceof TFolder) { p.children.push(f); f.parent = p; }
      return f;
    },
    addFolder(path) {
      const f = new MockTFolder(path); files.set(path, f);
      const p = files.get(parentOf(path)); if (p instanceof TFolder) { p.children.push(f); f.parent = p; }
      return f;
    },
    create(path, text = "x") { const f = self.addFile(path, text); emit("create", f); return f; },
    createFolder(path) { const f = self.addFolder(path); emit("create", f); return f; },
    modify(path) { const f = files.get(path); if (f) emit("modify", f); },
    remove(path) { const f = files.get(path); if (!f) return; files.delete(path); content.delete(path); const p = f.parent as TFolder | null; if (p) p.children = p.children.filter((c: unknown) => c !== f); emit("delete", f); },
    renameExternal(path, target) { void move(files.get(path)!, target); },
    fireLayoutReady() { for (const cb of layoutCallbacks.splice(0)) cb(); },
    listenerCount() { let n = 0; for (const s of handlers.values()) n += s.size; return n; },
  };

  async function move(file: TFile | TFolder, target: string): Promise<void> {
    const old = file.path;
    if (files.has(target)) throw new Error("Destination file already exists!");
    const touched: [TFile | TFolder, string][] = [[file, old]];
    if (file instanceof TFolder) {
      const walk = (f: TFolder): void => { for (const c of f.children as (TFile | TFolder)[]) { touched.push([c, c.path]); if (c instanceof TFolder) walk(c); } };
      walk(file);
    }
    for (const [f, p] of touched) {
      const np = target + p.slice(old.length);
      files.delete(p); f.path = np; f.name = np.split("/").pop() ?? np; files.set(np, f);
      if (content.has(p)) { content.set(np, content.get(p)!); content.delete(p); }
      if (fm.has(p)) { fm.set(np, fm.get(p)!); fm.delete(p); }
      if (f instanceof TFile) { const d = f.name.lastIndexOf("."); f.basename = d > 0 ? f.name.slice(0, d) : f.name; }
    }
    for (const [f, p] of touched) emit("rename", f, p);
  }

  const app = {
    vault: {
      on: (name: string, cb: Handler) => { let s = handlers.get(name); if (!s) { s = new Set(); handlers.set(name, s); } s.add(cb); return { name, cb }; },
      offref: (ref: { name: string; cb: Handler }) => { handlers.get(ref.name)?.delete(ref.cb); },
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      getAllLoadedFiles: () => [...files.values()],
      getConfig: (k: string) => (k === "alwaysUpdateLinks" ? config.alwaysUpdateLinks : undefined),
      readBinary: (f: TFile) => Promise.resolve(new TextEncoder().encode(content.get(f.path) ?? "").buffer),
      cachedRead: (f: TFile) => Promise.resolve(content.get(f.path) ?? ""),
    },
    fileManager: {
      renameFile: (f: TFile | TFolder, target: string) => { calls.push(`rename ${f.path} -> ${target}`); return self.renameImpl ? self.renameImpl(f, target) : move(f, target); },
      processFrontMatter: async (f: TFile, fn: (fm: Record<string, unknown>) => void) => {
        calls.push(`frontmatter ${f.path}`);
        if (self.frontmatterImpl) await self.frontmatterImpl(f);
        const cur = fm.get(f.path) ?? {}; fn(cur); fm.set(f.path, cur);
      },
    },
    metadataCache: { getFileCache: (f: TFile) => (fm.has(f.path) ? { frontmatter: fm.get(f.path) } : null) },
    workspace: { onLayoutReady: (cb: () => void) => { layoutCallbacks.push(cb); } },
  };
  self.app = app as unknown as App;
  return self;
}
