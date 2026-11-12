import { TFile, TFolder } from "obsidian";
import type { App, EventRef, TAbstractFile } from "obsidian";
import { OWN_TARGET_TTL_MS, RENAME_DEADLINE_MS, REPEAT_LIMIT, REPEAT_WINDOW_MS } from "../core/constants";
import { decide, initialSnapshot, orderForRepair, targetFor, type Decision, type TargetState, type Trigger } from "../core/decide";
import { toLogLine, summarizeBurst, type LogEvent, type LogInput } from "../core/log-entry";
import { createQuietQueue, type Timers } from "../core/queue";
import { createRepeatGuard } from "../vendor/kit/repeat-guard";
import type { ReviewEntry } from "../core/review-entry";
import { scanDecisions } from "../core/scan";
import type { SanitizerSettings } from "../core/settings";
import { applyPolicy, checkSegment, type FilenameHit } from "../vendor/kit/filename-policy";

export type { ReviewEntry };

export interface DeviceState {
  repairs: boolean;
  name: string;
  snapshot: () => Set<string>;
  hasSnapshot: () => boolean;
  saveSnapshot: (paths: string[]) => void;
  /** Stand der Richtlinie, gegen den der Altbestand zuletzt abgeglichen wurde; `null` vor dem ersten Abgleich. */
  policyKey: () => string | null;
  savePolicyKey: (key: string) => void;
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
  /** Einmal je Sitzung, wenn die Automatik wegen `alwaysUpdateLinks` aus ruht. */
  notifyLinkSetting?: () => void;
  environment?: () => { pluginVersion: string; obsidianVersion: string; platform: string };
  timers: Timers;
  now: () => number;
}

/** Zeit ohne weitere Reparatur, nach der das gebündelte Popup erscheint. */
const BURST_MS = 2000;
/** Größere Dateien werden für den Dublettenvergleich nicht gelesen (Speicher, Mobilgeräte); sie gelten als verschieden und bekommen eine Nummer. */
const MAX_COMPARE_BYTES = 50_000_000;
const fold = (s: string): string => s.normalize("NFC").toLowerCase();
const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const stemOf = (name: string): string => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(0, i) : name; };
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

/** Was vor der Umbenennung gelesen wurde und danach ins Protokoll gehört. */
interface RenameContext {
  oldPath: string;
  rules: string[];
  stat: { ctime: number; mtime: number; size: number } | null;
  frontmatter: Record<string, unknown> | undefined;
  content: string | undefined;
}

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
  private readonly lateTimers = new Set<unknown>();
  private quiet = false;
  private linkNoted = false;
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
    for (const h of this.lateTimers) this.deps.timers.clearTimeout(h);
    this.lateTimers.clear();
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

  /**
   * Eine Regeländerung (auch von einem anderen Gerät mitsynchronisiert) macht Bestandsnamen ungültig, die vorher gültig waren:
   * sie gelten als Altbestand und gehen in die Prüfliste, die Automatik fasst sie nicht an (Entscheidung 2026-11-08).
   * Ohne gespeicherten Stand (ältere Installation) gibt es nichts zu vergleichen; er wird nur festgehalten.
   */
  private absorbPolicyChange(entries: { path: string; isFolder: boolean }[]): boolean {
    const device = this.deps.device;
    const key = this.policyKey();
    const stored = device.policyKey();
    if (stored === key) return false;
    if (stored !== null) device.saveSnapshot([...new Set([...device.snapshot(), ...initialSnapshot(entries, this.deps.settings().policy)])]);
    device.savePolicyKey(key);
    return true;
  }

  private policyKey(): string { return JSON.stringify(this.deps.settings().policy); }

  /** Nach dem Speichern der Einstellungen: neu betroffener Bestand wird Altbestand und erscheint in der Prüfliste, bevor ein Ereignis ihn umbenennt. */
  policyChanged(): void {
    if (!this.deps.device.hasSnapshot()) return;
    const entries = this.app.vault.getAllLoadedFiles()
      .filter((f) => f.path !== "" && f.path !== "/")
      .map((f) => ({ path: f.path, isFolder: f instanceof TFolder }));
    if (this.absorbPolicyChange(entries)) void this.scanNow();
  }

  /** Prüft den ganzen Vault; der Start ruft es einmal. */
  async scanNow(): Promise<void> {
    const settings = this.deps.settings();
    const device = this.deps.device;
    const entries = this.app.vault.getAllLoadedFiles()
      .filter((f) => f.path !== "" && f.path !== "/")
      .map((f) => ({ path: f.path, isFolder: f instanceof TFolder }));
    if (!device.hasSnapshot()) { device.saveSnapshot(initialSnapshot(entries, settings.policy)); device.savePolicyKey(this.policyKey()); }
    else this.absorbPolicyChange(entries);
    this.quiet = true;
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
    this.quiet = false;
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
    if (!this.queue) return;
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
    const isFolder = file instanceof TFolder;
    const kept = this.review.get(oldPath);
    this.dropReview(oldPath);
    this.moveInSnapshot(oldPath, file.path, isFolder);
    // Ein Eintrag der Prüfliste (auch der Kinder eines umbenannten Ordners) zieht mit; ohne Fund am neuen Pfad ist er erledigt.
    if (kept && this.hasFinding(file.path, isFolder)) this.setReview(file.path, isFolder, kept.reason, kept.hits);
    this.onEvent(file, "rename");
  }

  /** Der Schnappschuss des Altbestands ist nach Pfad geschlüsselt: eine Umbenennung (auch von außen, durch Sync) nimmt den Eintrag mit. */
  private moveInSnapshot(oldPath: string, newPath: string, isFolder: boolean): void {
    const device = this.deps.device;
    if (!device.hasSnapshot()) return;
    const snap = device.snapshot();
    if (!snap.has(oldPath)) return;
    snap.delete(oldPath);
    if (this.hasFinding(newPath, isFolder)) snap.add(newPath);
    device.saveSnapshot([...snap]);
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
    // Aus der Prüfliste kommen die Ordner selbst in `paths` (Ordner zuerst); ein nicht angehakter Elternordner bleibt, wie er ist.
    if (trigger !== "list") await this.repairAncestors(file, trigger);
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
        if (decision.reason === "link-setting" && !this.linkNoted) { this.linkNoted = true; this.deps.notifyLinkSetting?.(); }
        if (decision.reason === "repeat") this.noteRepeat(file, trigger);
        else if (decision.reason !== "legacy") this.logOnce(file, "vorgemerkt", trigger, decision.hits, decision.reason);
        return;
      case "identical":
        this.setReview(current, isFolder, "identical", [], decision.target);
        this.logOnce(file, "identisch", trigger, [], undefined, decision.target);
        return;
      case "rename":
        if (!this.deps.device.repairs && trigger !== "list") { this.setReview(current, isFolder, "mode", decision.hits, decision.target); return; }
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
          const other = this.lookup(target);
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
    if (a.stat.size !== b.stat.size || a.stat.size > MAX_COMPARE_BYTES) return false;
    try {
      const [x, y] = await Promise.all([this.app.vault.readBinary(a), this.app.vault.readBinary(b)]);
      if (x.byteLength !== y.byteLength) return false;
      const u = new Uint8Array(x); const v = new Uint8Array(y);
      for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false;
      return true;
    } catch { return false; }
  }

  /** Ziel suchen, wie Dateisysteme es sehen: auch bei anderer Groß-/Kleinschreibung und Unicode-Form im selben Ordner (macOS). */
  private lookup(path: string): TAbstractFile | null {
    const exact = this.app.vault.getAbstractFileByPath(path);
    if (exact) return exact;
    const i = path.lastIndexOf("/");
    const dir = i < 0 ? "" : path.slice(0, i);
    const root = (this.app.vault as unknown as { getRoot?: () => TAbstractFile }).getRoot?.();
    const parent = dir === "" ? root : this.app.vault.getAbstractFileByPath(dir);
    if (!(parent instanceof TFolder)) return null;
    const key = fold(path.slice(i + 1));
    return parent.children.find((c) => fold(c.name) === key) ?? null;
  }

  private retry(path: string, trigger: Trigger): void {
    this.triggers.set(path, trigger);
    this.queue?.touch(path);
  }

  private async renameWithDeadline(file: TFile | TFolder, target: string): Promise<{ outcome: "ok" | "timeout"; done: Promise<void> }> {
    let handle: unknown;
    const timeout = new Promise<"timeout">((resolve) => { handle = this.deps.timers.setTimeout(() => { resolve("timeout"); }, RENAME_DEADLINE_MS); });
    const done = Promise.resolve(this.app.fileManager.renameFile(file, target)).then(() => undefined);
    done.catch(() => undefined);
    try { const outcome = await Promise.race([done.then(() => "ok" as const), timeout]); return { outcome, done }; } finally { this.deps.timers.clearTimeout(handle); }
  }

  private async doRename(file: TFile | TFolder, d: Extract<Decision, { kind: "rename" }>, trigger: Trigger): Promise<void> {
    const settings = this.deps.settings();
    const oldPath = file.path;
    const isFolder = file instanceof TFolder;
    const stat = file instanceof TFile ? { ...file.stat } : null;
    const frontmatter = !isFolder && settings.logFields.frontmatter ? this.pickFrontmatter(file, settings.logFrontmatterKeys) : undefined;
    const content = file instanceof TFile && file.extension === "md" && settings.logFields.content ? await this.readHead(file, settings.logContentChars) : undefined;
    const rules = unique(d.hits.map((h) => h.rule));

    // Neuprüfung direkt vor dem Umbenennen (Spec § 6, Schritt 3): während der Lesezugriffe oben kann die Datei weggezogen sein oder das Ziel entstanden.
    if (this.app.vault.getAbstractFileByPath(oldPath) !== file) return;
    if (this.lookup(d.target)) { this.retry(oldPath, trigger); return; }

    this.ownTargets.add(d.target);
    if (isFolder) this.ownPrefixes.add(`${d.target}/`);
    let outcome: "ok" | "timeout"; let done: Promise<void>;
    try {
      ({ outcome, done } = await this.renameWithDeadline(file, d.target));
    } catch (e) {
      this.ownTargets.delete(d.target); this.ownPrefixes.delete(`${d.target}/`);
      const collision = /already exists/i.test(messageOf(e));
      this.write({ event: collision ? "kollision" : "fehlgeschlagen", oldPath, newPath: d.target, rules, trigger, message: messageOf(e) });
      // Ein Fehlschlag zählt für den Wiederholungsschutz und kommt, solange er nicht gesperrt ist, mit neuer Entscheidung wieder.
      this.guard.record(oldPath);
      if (this.app.vault.getAbstractFileByPath(oldPath) === file) {
        if (this.guard.isBlocked(oldPath)) { this.setReview(oldPath, isFolder, "repeat", d.hits, d.target); this.noteRepeat(file, trigger); }
        else this.retry(oldPath, trigger);
      }
      return;
    }
    if (outcome === "timeout") {
      this.halted = true;
      this.write({ event: "fehlgeschlagen", oldPath, newPath: d.target, rules, trigger, message: `rename exceeded ${RENAME_DEADLINE_MS} ms; automatic repair paused until restart` });
      this.deps.notifyStalled?.(oldPath);
      this.watchLateRename(done, file, d, trigger, { oldPath, rules, stat, frontmatter, content });
      return;
    }
    this.ownTargets.delete(d.target); this.ownPrefixes.delete(`${d.target}/`);
    await this.finishRename(file, d, trigger, { oldPath, rules, stat, frontmatter, content });
  }

  /**
   * Nach dem Fristablauf wartet der Dialog „Update links“ womöglich noch. Wird er später bestätigt, ist die Datei umbenannt:
   * das gehört ins Protokoll, und der eigene Zielpfad ist danach nichts Besonderes mehr. Bleibt der Dialog stehen,
   * räumt die Zeitgrenze den Zielpfad.
   */
  private watchLateRename(done: Promise<void>, file: TFile | TFolder, d: Extract<Decision, { kind: "rename" }>, trigger: Trigger, ctx: RenameContext): void {
    const release = (): void => { this.ownTargets.delete(d.target); this.ownPrefixes.delete(`${d.target}/`); };
    const handle = this.deps.timers.setTimeout(() => { this.lateTimers.delete(handle); release(); }, OWN_TARGET_TTL_MS);
    this.lateTimers.add(handle);
    const settle = (): void => { this.deps.timers.clearTimeout(handle); this.lateTimers.delete(handle); release(); };
    done.then(
      () => { settle(); return this.run(() => this.finishRename(file, d, trigger, ctx, true)); },
      () => { settle(); },
    ).catch(() => undefined);
  }

  /** Alles, was nach einer gelungenen Umbenennung folgt: Alias, Sammelmeldung, Protokollzeile. */
  private async finishRename(file: TFile | TFolder, d: Extract<Decision, { kind: "rename" }>, trigger: Trigger, ctx: RenameContext, late = false): Promise<void> {
    const settings = this.deps.settings();
    const { oldPath, rules, stat, frontmatter, content } = ctx;
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
    let environment: ReturnType<NonNullable<EngineDeps["environment"]>> | undefined;
    try { environment = this.deps.environment?.(); } catch { environment = undefined; }
    this.write({
      event: "repariert", oldPath, newPath: d.target, rules, trigger,
      origin: stat ? { ctime: stat.ctime, mtime: stat.mtime, size: stat.size, secondsToRepair: Math.max(0, Math.round((now - stat.ctime) / 1000)), burstCount: this.burst.length } : undefined,
      effect: { aliasSet }, environment, frontmatter, content,
      message: [late ? `confirmed after the ${RENAME_DEADLINE_MS} ms deadline` : undefined, aliasError].filter(Boolean).join("; ") || undefined,
    });
    if (file instanceof TFolder) this.touchDescendants(file);
  }

  /** Der Ordner ist umbenannt; seine Kinder trugen den alten Pfad. Mit falschem Namen kommen sie neu in die Ruhezeit. */
  private touchDescendants(folder: TFolder, snapshot: ReadonlySet<string> = this.deps.device.snapshot()): void {
    for (const child of folder.children) {
      const isFolder = child instanceof TFolder;
      // Altbestand und Prüflisten-Einträge ziehen mit dem Ordner um (`onRename`) und bleiben, was sie waren.
      if (this.hasFinding(child.path, isFolder) && !this.review.has(child.path) && !snapshot.has(child.path)) this.retry(child.path, "rename");
      if (child instanceof TFolder) this.touchDescendants(child, snapshot);
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
    this.repeatNoted.delete(path);
    if (this.review.delete(path)) this.emit();
  }

  private emit(): void {
    if (this.quiet) return;
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
