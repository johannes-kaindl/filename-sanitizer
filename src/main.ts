import { Notice, Platform, Plugin, getLanguage } from "obsidian";
import "./i18n/strings";
import { createApi } from "./core/api";
import { toLogLine } from "./core/log-entry";
import { loadSettings, type SanitizerSettings } from "./core/settings";
import { pickLang, setLang, t } from "./vendor/kit/i18n";
import { tn } from "./i18n/strings";
import type { FilenameSanitizerApi } from "./vendor/kit/filename-sanitizer-source";
import { createDeviceState } from "./obsidian/device";
import { RepairEngine } from "./obsidian/engine";
import { FilenameSanitizerSettingTab } from "./obsidian/settings-tab";
import { createLogStore } from "./obsidian/log-store";
import { SanitizerView, VIEW_TYPE_SANITIZER, type SanitizerTab } from "./obsidian/view";

function safeGetLanguage(): string | null {
  try { return getLanguage(); } catch { return null; }
}

function platformName(): string {
  if (Platform.isIosApp) return "iOS";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isMobile) return "mobile";
  if (Platform.isMacOS) return "macOS";
  if (Platform.isWin) return "Windows";
  return Platform.isLinux ? "Linux" : "desktop";
}

export default class FilenameSanitizerPlugin extends Plugin {
  settings: SanitizerSettings = loadSettings(null);
  /** Öffentliche Plugin-API v1 (`app.plugins.plugins["filename-sanitizer"].api`). */
  api!: FilenameSanitizerApi;
  engine!: RepairEngine;
  device!: ReturnType<typeof createDeviceState>;
  /** Wird von der Ansicht gesetzt (Task 10); bis dahin tut ein Klick auf das Popup nichts. */
  openLog: (() => void) | null = null;
  logStore!: ReturnType<typeof createLogStore>;

  async onload(): Promise<void> {
    setLang(pickLang(safeGetLanguage()));
    this.settings = loadSettings(await this.loadData());
    this.device = createDeviceState(this.app);
    this.logStore = createLogStore(this.app, { settings: () => this.settings, deviceName: () => this.device.name });
    this.api = createApi({
      settings: () => this.settings,
      logChange: (caller, before, result) => {
        this.logStore.write(toLogLine({
          time: Date.now(), event: "repariert", oldPath: before, newPath: result.name, rules: result.hits.map((h) => h.rule),
          trigger: "api", caller, device: this.device.name, mode: this.settings.mode,
        }, this.settings.logFields), Date.now());
      },
    });
    this.engine = new RepairEngine(this.app, {
      settings: () => this.settings, device: this.device, log: this.logStore,
      timers: { setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (h) => { window.clearTimeout(h as number); } },
      now: () => Date.now(),
      environment: () => ({ pluginVersion: this.manifest.version, obsidianVersion: (this.app as unknown as { appVersion?: string }).appVersion ?? "", platform: platformName() }),
      notify: (b) => {
        const text = b.single ? t("notice.repaired.one", b.single.oldName, b.single.newName) : t("notice.repaired.many", b.count);
        this.notice(text, true);
      },
      notifyRepeat: (path) => { this.notice(t("notice.repeat", path), false); },
      notifyStalled: (path) => { this.notice(t("notice.stalled", path), false); },
    });
    this.openLog = () => { void this.activateView("log"); };
    this.registerView(VIEW_TYPE_SANITIZER, (leaf) => new SanitizerView(leaf, this));
    this.addCommand({ id: "open-review-and-log", name: t("cmd.open"), icon: "list-checks", callback: () => { void this.activateView("review"); } });
    this.addCommand({
      id: "check-file-names", name: t("cmd.check"), icon: "scan-search",
      callback: async () => {
        await this.engine.scanNow();
        const n = this.engine.pending().length;
        this.notice(n === 0 ? t("cmd.checkDone.none") : tn("cmd.checkDone.some", n), false);
      },
    });
    this.addSettingTab(new FilenameSanitizerSettingTab(this.app, this));
    this.engine.start();
    void this.logStore.rotate(Date.now());
  }

  onunload(): void {
    this.engine.stop();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(tab: SanitizerTab): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SANITIZER)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_SANITIZER, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (leaf.view instanceof SanitizerView) leaf.view.showTab(tab);
  }

  /** Ein Popup; mit `openOnClick` öffnet ein Klick das Protokoll. */
  private notice(text: string, openOnClick: boolean): void {
    const n = new Notice(text, openOnClick ? 8000 : 15000);
    if (openOnClick) n.messageEl.addEventListener("click", () => { this.openLog?.(); });
  }
}
