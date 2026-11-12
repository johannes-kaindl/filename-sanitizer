import { ItemView, Notice, TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { LogEvent, LogInput } from "../core/log-entry";
import { logFilterOptions, logRows, type LogFilter } from "../core/log-view";
import { applyGate, reviewItems } from "../core/review-view";
import { tn } from "../i18n/strings";
import { t } from "../vendor/kit/i18n";
import { exactIgnoreLine } from "../vendor/kit/ignore";
import { buildHubInto, type HubController, type HubPanel } from "../vendor/kit-obsidian/hub";
import { buildReviewList, type ReviewListStrings } from "../vendor/kit-obsidian/review-list";
import type FilenameSanitizerPlugin from "../main";

export const VIEW_TYPE_SANITIZER = "filename-sanitizer-view";
export type SanitizerTab = "review" | "log";

const LOG_LIMIT = 500;

export type KeepAlways = { kind: "added"; exceptions: string } | { kind: "present" } | { kind: "impossible" };

/** „Immer so lassen“: hängt die genaue Zeile für `path` an die Ausnahmen. `impossible`, wenn keine Zeile genau diesen Pfad ausdrücken kann (Randleerzeichen, doppelte Slashes, Zeilenumbruch); dann wird nichts angelegt. */
export function addKeepAlways(exceptions: string, path: string): KeepAlways {
  const line = exactIgnoreLine(path);
  if (line === null) return { kind: "impossible" };
  if (exceptions.split("\n").some((l) => l.trim() === line)) return { kind: "present" };
  return { kind: "added", exceptions: exceptions.trim() === "" ? line : `${exceptions.replace(/\s+$/, "")}\n${line}` };
}
/** Gründe, die der Motor als `message` einer Zeile „vorgemerkt“ schreibt. */
const REASON_KEYS = ["mode", "link-setting", "legacy", "repeat"];

function reviewStrings(): ReviewListStrings {
  return {
    accept: t("review.accept"), reject: t("review.reject"), comment: t("review.keepAlways"), reply: "", resolve: "", reopen: "",
    acceptAll: t("review.acceptAll"), rejectAll: t("review.rejectAll"), openCount: (n) => tn("review.openCount", n),
    empty: t("review.empty"), stale: t("review.stale"), orphan: t("review.orphan"),
    kind: { insertion: t("review.kind.insertion"), deletion: t("review.kind.deletion"), substitution: t("review.kind.substitution") },
    decided: { accepted: t("review.decided.accepted"), rejected: t("review.decided.rejected") },
  };
}

/** Was ein Neuzeichnen der Prüfliste nicht verlieren darf: wie weit gescrollt ist und welches Bedienelement den Fokus hat. */
interface UiSnapshot {
  scroll: { el: HTMLElement; top: number }[];
  /** Karte (`data-id`) und Platz des fokussierten Elements darin; `apply` für den Knopf „Umbenennen“. */
  focus: { card: string; index: number } | "apply" | null;
}

class ReviewPanel implements HubPanel<"review"> {
  readonly id = "review" as const;
  readonly icon = "list-checks";
  private container: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Abgewählte Pfade; alles andere in der Liste ist angehakt, auch neu Hinzukommendes. */
  private readonly unticked = new Set<string>();
  /** Zuletzt fokussierter Platz im Panel; weg, sobald der Fokus bewusst in ein anderes Element außerhalb wandert. */
  private lastFocus: UiSnapshot["focus"] = null;
  constructor(private readonly plugin: FilenameSanitizerPlugin) {}

  get label(): string { return t("tab.review"); }

  mount(container: HTMLElement): void {
    this.container = container;
    container.addEventListener("focusin", (e) => { this.lastFocus = this.focusOf(container, e.target as HTMLElement); });
    container.addEventListener("focusout", (e) => {
      const next = e.relatedTarget as HTMLElement | null;
      if (next && !container.contains(next)) this.lastFocus = null;
    });
    this.unsubscribe = this.plugin.engine.onChange(() => { this.render(); });
    this.render();
  }

  onShow(): void { this.render(); }

  destroy(): void { this.unsubscribe?.(); this.unsubscribe = null; }

  /** Wo im Panel der Fokus liegt: die Karte (`data-id`) und der Platz des Elements darin, oder der Knopf „Umbenennen“. */
  private focusOf(c: HTMLElement, el: HTMLElement | null | undefined): UiSnapshot["focus"] {
    if (!el || !c.contains(el)) return null;
    const card = el.closest<HTMLElement>("[data-id]");
    if (card) return { card: card.getAttribute("data-id") ?? "", index: Array.from(card.querySelectorAll<HTMLElement>("button, [tabindex]")).indexOf(el) };
    return el.closest(".fsan-apply") ? "apply" : null;
  }

  private snapshotUi(c: HTMLElement): UiSnapshot {
    const scroll: UiSnapshot["scroll"] = [];
    for (let el: HTMLElement | null = c; el; el = el.parentElement) if (el.scrollTop > 0) scroll.push({ el, top: el.scrollTop });
    const active = c.ownerDocument?.activeElement as HTMLElement | null | undefined;
    // Der Kit-Baustein sperrt während einer Aktion alle Knöpfe; ein gesperrter Knopf verliert den Fokus (activeElement ist dann `body`),
    // bevor die Ansicht neu zeichnet. Dann gilt der zuletzt gemerkte Platz, solange kein anderes Element den Fokus hält.
    const focus = this.focusOf(c, active) ?? (!active || active === c.ownerDocument?.body ? this.lastFocus : null);
    return { scroll, focus };
  }

  private restoreUi(c: HTMLElement, snap: UiSnapshot): void {
    if (snap.focus === "apply") c.querySelector<HTMLElement>(".fsan-apply button")?.focus({ preventScroll: true });
    else if (snap.focus) {
      const { card: id, index } = snap.focus;
      const card = Array.from(c.querySelectorAll<HTMLElement>("[data-id]")).find((e) => e.getAttribute("data-id") === id);
      const targets = card ? Array.from(card.querySelectorAll<HTMLElement>("button, [tabindex]")) : [];
      (targets[index] ?? card)?.focus({ preventScroll: true });
    }
    for (const { el, top } of snap.scroll) el.scrollTop = top;
  }

  private render(): void {
    const c = this.container;
    if (!c) return;
    const snap = this.snapshotUi(c);
    this.draw(c);
    this.restoreUi(c, snap);
  }

  private draw(c: HTMLElement): void {
    c.empty();
    c.addClass("fsan-panel");
    const entries = this.plugin.engine.pending();
    const ticks = new Set(entries.filter((e) => !this.unticked.has(e.path)).map((e) => e.path));
    const gate = applyGate(entries, ticks, { deviceRepairs: this.plugin.device.repairs });
    const items = reviewItems(entries, ticks);

    if (entries.length > 0) {
      const row = c.createDiv({ cls: "fsan-apply" });
      const count = gate.ok ? gate.paths.length : ticks.size;
      const btn = row.createEl("button", { cls: "mod-cta", text: count > 0 ? t("review.applyCount", count) : t("review.apply"), attr: { type: "button" } });
      btn.disabled = !gate.ok;
      btn.addEventListener("click", () => { if (gate.ok) void this.plugin.engine.applyReview(gate.paths, [...this.unticked]); });
      if (!gate.ok) row.createDiv({ cls: gate.why === "nothing" ? "fsan-note" : "fsan-warning", text: t(`review.locked.${gate.why}`) });
    }

    buildReviewList(c, {
      items, strings: reviewStrings(),
      onAction: async (action, id) => {
        if (action === "accept") this.unticked.delete(id);
        else if (action === "reject") this.unticked.add(id);
        else if (action === "comment") await this.keepAlways(id);
        else if (action === "jump") this.jump(id);
        this.render();
      },
      onBulk: (action) => {
        if (action === "accept-all") this.unticked.clear();
        else for (const e of entries) this.unticked.add(e.path);
        this.render();
      },
      onError: (e) => { console.error("filename-sanitizer: review action failed", e); },
    });

    if (entries.some((e) => e.reason === "identical")) c.createDiv({ cls: "fsan-note", text: t("review.duplicateHint") });
  }

  /** „Immer so lassen“: der genaue Pfad kommt in die Ausnahmen, der Eintrag verschwindet beim nächsten Scan. */
  private async keepAlways(path: string): Promise<void> {
    const s = this.plugin.settings;
    const r = addKeepAlways(s.exceptions, path);
    if (r.kind === "impossible") { new Notice(t("notice.keepImpossible", path)); return; }
    if (r.kind === "present") return;
    s.exceptions = r.exceptions;
    await this.plugin.saveSettings();
    await this.plugin.engine.scanNow();
  }

  private jump(path: string): void {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.plugin.app.workspace.getLeaf(false).openFile(file);
  }
}

class LogPanel implements HubPanel<"log"> {
  readonly id = "log" as const;
  readonly icon = "scroll-text";
  private container: HTMLElement | null = null;
  private entries: LogInput[] = [];
  private filter: LogFilter = {};
  constructor(private readonly plugin: FilenameSanitizerPlugin) {}

  get label(): string { return t("tab.log"); }

  mount(container: HTMLElement): void { this.container = container; this.render(); }

  onShow(): void { void this.reload(); }

  destroy(): void { this.container = null; }

  private async reload(): Promise<void> {
    this.entries = await this.plugin.logStore.read(LOG_LIMIT);
    this.render();
  }

  private render(): void {
    const c = this.container;
    if (!c) return;
    c.empty();
    c.addClass("fsan-panel");
    if (this.entries.length === 0) {
      c.createDiv({ cls: "fsan-empty", text: t("log.empty") });
      this.refreshButton(c);
      return;
    }
    const opts = logFilterOptions(this.entries);
    const bar = c.createDiv({ cls: "fsan-filters" });
    this.select(bar, t("log.filter.device"), opts.devices.map((d) => [d, d]), this.filter.device, (v) => { this.filter = { ...this.filter, device: v }; });
    this.select(bar, t("log.filter.event"), opts.events.map((e) => [e, t(`log.event.${e}`)]), this.filter.event, (v) => { this.filter = { ...this.filter, event: v as LogEvent | undefined }; });
    const folderWrap = bar.createEl("label", { cls: "fsan-filter" });
    folderWrap.createSpan({ text: t("log.filter.folder") });
    const folder = folderWrap.createEl("input", { attr: { type: "text" } });
    folder.value = this.filter.folder ?? "";
    folder.addEventListener("change", () => { this.filter = { ...this.filter, folder: folder.value.trim() === "" ? undefined : folder.value.trim() }; this.render(); });
    this.refreshButton(bar);

    const rows = logRows(this.entries, this.filter);
    if (rows.length === 0) { c.createDiv({ cls: "fsan-empty", text: t("log.noMatch") }); return; }
    const list = c.createDiv({ cls: "fsan-log-list" });
    for (const r of rows) {
      const row = list.createDiv({ cls: "fsan-log-row" });
      const head = row.createDiv({ cls: "fsan-log-head" });
      head.createSpan({ cls: "fsan-log-event", text: t(`log.event.${r.event}`) });
      head.createSpan({ text: new Date(r.time).toLocaleString() });
      head.createSpan({ text: r.device });
      if (r.caller) head.createSpan({ text: t("log.by", r.caller) });
      row.createDiv({ cls: "fsan-log-paths", text: r.newPath ? `${r.oldPath} → ${r.newPath}` : r.oldPath });
      const detail = [r.trigger, ...r.rules].join(" · ");
      if (detail !== "") row.createDiv({ cls: "fsan-log-message", text: detail });
      if (r.message) row.createDiv({ cls: "fsan-log-message", text: REASON_KEYS.includes(r.message) ? t(`review.reason.${r.message}`) : r.message });
    }
  }

  private select(parent: HTMLElement, label: string, options: [string, string][], current: string | undefined, onPick: (v: string | undefined) => void): void {
    const wrap = parent.createEl("label", { cls: "fsan-filter" });
    wrap.createSpan({ text: label });
    const sel = wrap.createEl("select", { cls: "dropdown" });
    sel.createEl("option", { text: t("log.filter.all"), attr: { value: "" } });
    for (const [value, text] of options) sel.createEl("option", { text, attr: { value } });
    sel.value = current ?? "";
    sel.addEventListener("change", () => { onPick(sel.value === "" ? undefined : sel.value); this.render(); });
  }

  private refreshButton(parent: HTMLElement): void {
    const b = parent.createEl("button", { text: t("log.refresh"), attr: { type: "button" } });
    b.addEventListener("click", () => { void this.reload(); });
  }
}

export class SanitizerView extends ItemView {
  private hub: HubController<SanitizerTab> | null = null;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: FilenameSanitizerPlugin) { super(leaf); }

  getViewType(): string { return VIEW_TYPE_SANITIZER; }
  getDisplayText(): string { return t("view.title"); }
  getIcon(): string { return "file-check"; }

  onOpen(): Promise<void> {
    this.contentEl.addClass("fsan-root");
    this.hub = buildHubInto<SanitizerTab>(this.contentEl, [new ReviewPanel(this.plugin), new LogPanel(this.plugin)], "review");
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.hub?.destroy();
    this.hub = null;
    return Promise.resolve();
  }

  showTab(tab: SanitizerTab): void { this.hub?.setTab(tab); }
}
