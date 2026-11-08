import { TFile, TFolder } from "obsidian";
import type { App, EventRef, TAbstractFile } from "obsidian";
import { RENAME_DEADLINE_MS, REPEAT_LIMIT, REPEAT_WINDOW_MS } from "../core/constants";
import { decide, initialSnapshot, orderForRepair, targetFor, type Decision, type ReviewReason, type TargetState, type Trigger } from "../core/decide";
import { toLogLine, summarizeBurst, type LogEvent, type LogInput } from "../core/log-entry";
import { createQuietQueue, type Timers } from "../core/queue";
import { createRepeatGuard } from "../core/repeat-guard";
import { scanDecisions } from "../core/scan";
import type { SanitizerSettings } from "../core/settings";
import { applyPolicy, checkSegment, type FilenameHit } from "../vendor/kit/filename-policy";

export interface ReviewEntry {
  path: string;
  isFolder: boolean;
  target: string;
  /** `stalled`: die Automatik hält an, weil eine Umbenennung die Frist überschritt. */
  reason: ReviewReason | "identical" | "stalled";
  hits: FilenameHit[];
}

export interface DeviceState {
  repairs: boolean;
  name: string;
  snapshot: () => Set<string>;
  hasSnapshot: () => boolean;
  saveSnapshot: (paths: string[]) => void;
}

export interface LogStore {
  write: (line: string, time: number) => void;
  read: (limit: number) => Promise<LogInput[]>;
  rotate: (now: number) => Promise<void>;
}

export interface EngineDeps {
  settings: () => SanitizerSettings;
  device: DeviceState;
  log: LogStore;
  notify: (burst: ReturnType<typeof summarizeBurst>) => void;
  notifyRepeat: (path: string) => void;
  notifyStalled?: (path: string) => void;
  environment?: () => { pluginVersion: string; obsidianVersion: string; platform: string };
  timers: Timers;
  now: () => number;
}

/** Zeit ohne weitere Reparatur, nach der das gebündelte Popup erscheint. */
const BURST_MS = 2000;
const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const stemOf = (name: string): string => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(0, i) : name; };
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** Repariert Namen, die fremde Schreiber anlegen: Ruhezeit, Neuprüfung, eine Umbenennung zur Zeit, nie ein Überschreiben. */
export class RepairEngine {
  private readonly review = new Map<string, ReviewEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly guard;
  private readonly triggers = new Map<string, Trigger>();
  private readonly logged = new Set<string>();
  private readonly repeatNoted = new Set<string>();
  private readonly ownTargets = new Set<string>();
  private readonly ownPrefixes = new Set<string>();
  private queue: ReturnType<typeof createQuietQueue> | null = null;
  private refs: EventRef[] = [];
  private chain: Promise<void> = Promise.resolve();
  private burstTimer: unknown = null;
  private halted = false;
  private stopped = true;
  private burst: { oldName: string; newName: string }[] = [];

  constructor(private readonly app: App, private readonly deps: EngineDeps) {
    this.guard = createRepeatGuard({ limit: REPEAT_LIMIT, windowMs: REPEAT_WINDOW_MS, now: () => deps.now() });
  }

  start(): void {
    this.stopped = false;
    this.halted = false;
    this.ownTargets.clear();
    this.ownPrefixes.clear();
    this.app.workspace.onLayoutReady(() => { if (!this.stopped) this.begin(); });
  }

  stop(): void {
    this.stopped = true;
    this.queue?.dispose();
    this.queue = null;
    if (this.burstTimer !== null) { this.deps.timers.clearTimeout(this.burstTimer); this.burstTimer = null; }
    this.flushBurst();
    for (const r of this.refs) this.app.vault.offref(r);
    this.refs = [];
  }

  pending(): ReviewEntry[] {
    return [...this.review.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** Prüft den ganzen Vault; der Start ruft es einmal. */
  async scanNow(): Promise<void> {
    const settings = this.deps.settings();
    const device = this.deps.device;
    const entries = this.app.vault.getAllLoadedFiles()
      .filter((f) => f.path !== "" && f.path !== "/")
      .map((f) => ({ path: f.path, isFolder: f instanceof TFolder }));
    if (!device.hasSnapshot()) device.saveSnapshot(initialSnapshot(entries, settings.policy));
    this.review.clear();
    const found = scanDecisions(entries, {
      settings, linkAuto: this.linkAuto(), snapshot: device.snapshot(), trigger: "start",
      targetState: () => "free", isBlocked: (p) => this.guard.isBlocked(p),
    });
    for (const { entry, decision } of found) {
      if (decision.kind === "review") this.setReview(entry.path, entry.isFolder, decision.reason, decision.hits);
      else if (decision.kind === "rename" || decision.kind === "identical") {
        if (device.repairs) void this.run(() => this.process(entry.path, "start"));
        else this.setReview(entry.path, entry.isFolder, "mode", decision.kind === "rename" ? decision.hits : []);
      }
    }
    this.emit();
    await this.chain;
  }

  /** Benennt die angehakten Einträge der Prüfliste um; nicht genannte bleiben in der Liste. */
  async applyReview(paths: string[]): Promise<void> {
    if (!this.deps.device.repairs) return;
    const chosen = orderForRepair(paths.map((p) => this.review.get(p)).filter((e): e is ReviewEntry => e !== undefined));
    for (const e of chosen) void this.run(() => this.process(e.path, "list"));
    await this.chain;
  }

  // ---- Ereignisse -------------------------------------------------------

  private begin(): void {
    const settings = this.deps.settings();
    this.queue = createQuietQueue({
      quietMs: settings.quietMs, timers: this.deps.timers,
      onDue: (p) => { const trigger = this.triggers.get(p) ?? "modify"; this.triggers.delete(p); void this.run(() => this.process(p, trigger)); },
    });
    this.refs.push(
      this.app.vault.on("create", (f) => { this.onEvent(f, "create"); }),
      this.app.vault.on("modify", (f) => { this.onEvent(f, "modify"); }),
      this.app.vault.on("rename", (f, old) => { this.onRename(f, old); }),
      this.app.vault.on("delete", (f) => { this.onDelete(f); }),
    );
    void this.scanNow();
  }

  private isOwn(path: string): boolean {
    if (this.ownTargets.has(path)) return true;
    for (const p of this.ownPrefixes) if (path.startsWith(p)) return true;
    return false;
  }

  private hasFinding(path: string, isFolder: boolean): boolean {
    return checkSegment(lastSegment(path), this.deps.settings().policy, isFolder ? "folder" : "file").length > 0;
  }

  private onEvent(file: TAbstractFile, trigger: Trigger): void {
    if (!this.deps.device.repairs || !this.queue) return;
    const isFolder = file instanceof TFolder;
    if (!isFolder && !(file instanceof TFile)) return;
    if (this.isOwn(file.path)) return;
    if (!this.hasFinding(file.path, isFolder)) { this.queue.forget(file.path); this.dropReview(file.path); return; }
    this.triggers.set(file.path, trigger);
    this.queue.touch(file.path);
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    this.queue?.forget(oldPath);
    this.triggers.delete(oldPath);
    this.dropReview(oldPath);
    this.onEvent(file, "rename");
  }

  private onDelete(file: TAbstractFile): void {
    this.queue?.forget(file.path);
    this.triggers.delete(file.path);
    this.dropReview(file.path);
  }

  // ---- Ablauf -----------------------------------------------------------

  /** Eine Aufgabe nach der anderen. */
  private run(task: () => Promise<void>): Promise<void> {
    const p = this.chain.then(task).catch(() => undefined);
    this.chain = p;
    return p;
  }

  /** Alle Reparaturen eines Schubs ergeben ein Popup: es geht raus, wenn `BURST_MS` lang keine dazukam. */
  private scheduleFlush(): void {
    if (this.burstTimer !== null) this.deps.timers.clearTimeout(this.burstTimer);
    this.burstTimer = this.deps.timers.setTimeout(() => { this.burstTimer = null; this.flushBurst(); }, BURST_MS);
  }

  private flushBurst(): void {
    if (this.burst.length === 0) return;
    const items = this.burst; this.burst = [];
    if (this.deps.settings().showNotice) this.deps.notify(summarizeBurst(items));
  }

  private linkAuto(): boolean {
    const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
    return vault.getConfig?.("alwaysUpdateLinks") === true;
  }

  private async process(path: string, trigger: Trigger): Promise<void> {
    if (this.stopped) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) { this.dropReview(path); return; }
    if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
    await this.repairAncestors(file, trigger);
    // Der Ordner kann den Pfad verändert haben; ab hier zählt `file.path`.
    const decision = await this.resolve(file, trigger);
    const current = file.path;
    const isFolder = file instanceof TFolder;
    switch (decision.kind) {
      case "none":
      case "exception":
        this.dropReview(path); this.dropReview(current); return;
      case "review":
        this.setReview(current, isFolder, decision.reason, decision.hits);
        if (decision.reason === "repeat") this.noteRepeat(file, trigger);
        else if (decision.reason !== "legacy") this.logOnce(file, "vorgemerkt", trigger, decision.hits, decision.reason);
        return;
      case "identical":
        this.setReview(current, isFolder, "identical", [], decision.target);
        this.logOnce(file, "identisch", trigger, [], undefined, decision.target);
        return;
      case "rename":
        if (this.halted) { this.setReview(current, isFolder, "stalled", decision.hits, decision.target); return; }
        await this.doRename(file, decision, trigger);
    }
  }

  /** Ein Ordner mit falschem Namen kommt vor seinem Inhalt dran. */
  private async repairAncestors(file: TFile | TFolder, trigger: Trigger): Promise<void> {
    for (let depth = 1; ; depth++) {
      const parts = file.path.split("/");
      if (depth >= parts.length) return;
      const prefix = parts.slice(0, depth).join("/");
      const folder = this.app.vault.getAbstractFileByPath(prefix);
      if (folder instanceof TFolder && this.hasFinding(prefix, true)) await this.process(prefix, trigger);
    }
  }

  /** `decide` ist synchron; Inhaltsvergleiche für belegte Ziele werden vorab gelesen und wiederholt eingespielt. */
  private async resolve(file: TFile | TFolder, trigger: Trigger): Promise<Decision> {
    const cache = new Map<string, TargetState>();
    for (let round = 0; round < 50; round++) {
      const missing: { target: string; other: TFile }[] = [];
      const decision = decide({
        path: file.path, isFolder: file instanceof TFolder, settings: this.deps.settings(), linkAuto: this.linkAuto(),
        inSnapshot: this.deps.device.snapshot().has(file.path), repeatBlocked: this.guard.isBlocked(file.path), trigger,
        targetState: (target) => {
          const other = this.app.vault.getAbstractFileByPath(target);
          if (!other) return "free";
          if (other instanceof TFolder) return file instanceof TFolder ? "folder-exists" : "different";
          if (file instanceof TFolder || !(other instanceof TFile)) return "different";
          const hit = cache.get(target);
          if (hit) return hit;
          missing.push({ target, other });
          return "different";
        },
      });
      if (missing.length === 0 || !(file instanceof TFile)) return decision;
      for (const m of missing) cache.set(m.target, await this.sameBytes(file, m.other) ? "same-content" : "different");
    }
    return { kind: "review", reason: "repeat", hits: [] };
  }

  private async sameBytes(a: TFile, b: TFile): Promise<boolean> {
    if (a.stat.size !== b.stat.size) return false;
    try {
      const [x, y] = await Promise.all([this.app.vault.readBinary(a), this.app.vault.readBinary(b)]);
      if (x.byteLength !== y.byteLength) return false;
      const u = new Uint8Array(x); const v = new Uint8Array(y);
      for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
      return true;
    } catch { return false; }
  }

  private async renameWithDeadline(file: TFile | TFolder, target: string): Promise<"ok" | "timeout"> {
    let handle: unknown;
    const timeout = new Promise<"timeout">((resolve) => { handle = this.deps.timers.setTimeout(() => { resolve("timeout"); }, RENAME_DEADLINE_MS); });
    const done = Promise.resolve(this.app.fileManager.renameFile(file, target)).then(() => "ok" as const);
    done.catch(() => undefined);
    try { return await Promise.race([done, timeout]); } finally { this.deps.timers.clearTimeout(handle); }
  }

  private async doRename(file: TFile | TFolder, d: Extract<Decision, { kind: "rename" }>, trigger: Trigger): Promise<void> {
    const settings = this.deps.settings();
    const oldPath = file.path;
    const isFolder = file instanceof TFolder;
    const stat = file instanceof TFile ? { ...file.stat } : null;
    const frontmatter = !isFolder && settings.logFields.frontmatter ? this.pickFrontmatter(file, settings.logFrontmatterKeys) : undefined;
    const content = file instanceof TFile && file.extension === "md" && settings.logFields.content ? await this.readHead(file, settings.logContentChars) : undefined;
    const rules = unique(d.hits.map((h) => h.rule));

    this.ownTargets.add(d.target);
    if (isFolder) this.ownPrefixes.add(`${d.target}/`);
    let outcome: "ok" | "timeout";
    try {
      outcome = await this.renameWithDeadline(file, d.target);
    } catch (e) {
      this.ownTargets.delete(d.target); this.ownPrefixes.delete(`${d.target}/`);
      const collision = /already exists/i.test(messageOf(e));
      this.write({ event: collision ? "kollision" : "fehlgeschlagen", oldPath, newPath: d.target, rules, trigger, message: messageOf(e) });
      return;
    }
    if (outcome === "timeout") {
      this.halted = true;
      this.write({ event: "fehlgeschlagen", oldPath, newPath: d.target, rules, trigger, message: `rename exceeded ${RENAME_DEADLINE_MS} ms; automatic repair paused until restart` });
      this.deps.notifyStalled?.(oldPath);
      return;
    }
    this.ownTargets.delete(d.target); this.ownPrefixes.delete(`${d.target}/`);
    this.guard.record(oldPath);
    this.dropReview(oldPath);

    let aliasSet = false; let aliasError: string | undefined;
    if (settings.aliasOldName && file instanceof TFile && file.extension === "md") {
      const old = stemOf(lastSegment(oldPath));
      try {
        await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
          const cur = fm.aliases;
          const list = Array.isArray(cur) ? cur.map(String) : typeof cur === "string" && cur !== "" ? [cur] : [];
          if (list.includes(old)) return;
          fm.aliases = [...list, old]; aliasSet = true;
        });
      } catch (e) { aliasSet = false; aliasError = `alias not set: ${messageOf(e)}`; }
    }
    this.burst.push({ oldName: lastSegment(oldPath), newName: lastSegment(d.target) });
    this.scheduleFlush();
    const now = this.deps.now();
    this.write({
      event: "repariert", oldPath, newPath: d.target, rules, trigger,
      origin: stat ? { ctime: stat.ctime, mtime: stat.mtime, size: stat.size, secondsToRepair: Math.max(0, Math.round((now - stat.ctime) / 1000)), burstCount: this.burst.length } : undefined,
      effect: { aliasSet }, environment: this.deps.environment?.(), frontmatter, content, message: aliasError,
    });
    if (file instanceof TFolder) this.touchDescendants(file);
  }

  /** Der Ordner ist umbenannt; seine Kinder trugen den alten Pfad. Mit falschem Namen kommen sie neu in die Ruhezeit. */
  private touchDescendants(folder: TFolder): void {
    for (const child of folder.children) {
      const isFolder = child instanceof TFolder;
      if (this.hasFinding(child.path, isFolder)) { this.triggers.set(child.path, "rename"); this.queue?.touch(child.path); }
      if (child instanceof TFolder) this.touchDescendants(child);
    }
  }

  private pickFrontmatter(file: TFile, keys: string[]): Record<string, unknown> | undefined {
    const fm: Record<string, unknown> | undefined = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in fm) out[k] = fm[k];
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private async readHead(file: TFile, chars: number): Promise<string | undefined> {
    try { return (await this.app.vault.cachedRead(file)).slice(0, chars); } catch { return undefined; }
  }

  // ---- Prüfliste und Protokoll -----------------------------------------

  private setReview(path: string, isFolder: boolean, reason: ReviewEntry["reason"], hits: FilenameHit[], target?: string): void {
    const name = lastSegment(path);
    const t = target ?? targetFor(path, applyPolicy(name, this.deps.settings().policy, isFolder ? "folder" : "file").name);
    const old = this.review.get(path);
    if (old && old.reason === reason && old.target === t) return;
    this.review.set(path, { path, isFolder, target: t, reason, hits });
    this.emit();
  }

  private dropReview(path: string): void {
    if (this.review.delete(path)) this.emit();
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  private noteRepeat(file: TFile | TFolder, trigger: Trigger): void {
    if (this.repeatNoted.has(file.path)) return;
    this.repeatNoted.add(file.path);
    this.write({ event: "wiederholt", oldPath: file.path, rules: [], trigger });
    this.deps.notifyRepeat(file.path);
  }

  private logOnce(file: TFile | TFolder, event: LogEvent, trigger: Trigger, hits: FilenameHit[], reason?: string, newPath?: string): void {
    const key = `${event}:${file.path}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.write({ event, oldPath: file.path, newPath, rules: unique(hits.map((h) => h.rule)), trigger, message: reason });
  }

  private write(p: Pick<LogInput, "event" | "oldPath" | "rules" | "trigger"> & Partial<LogInput>): void {
    const settings = this.deps.settings();
    const input: LogInput = { ...p, time: this.deps.now(), device: this.deps.device.name, mode: settings.mode };
    try { this.deps.log.write(toLogLine(input, settings.logFields), input.time); } catch { /* Ein Protokollfehler bricht nie eine Reparatur ab. */ }
  }
}
