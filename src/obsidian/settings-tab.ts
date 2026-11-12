import { PluginSettingTab, Setting, type App, type SettingDefinitionItem } from "obsidian";
import type FilenameSanitizerPlugin from "../main";
import { checkNumber, trySetPolicy, type NumberKey, type PolicyField } from "../core/settings";
import { DEFAULT_FILENAME_POLICY, checkFolderPath, type ReplaceableRule } from "../vendor/kit/filename-policy";
import { t } from "../vendor/kit/i18n";
import { collapsibleSection } from "../vendor/kit-obsidian/collapsible";
import { FolderSuggest } from "../vendor/kit-obsidian/folder-suggest";
import { githubHelpUrls, helpSettingDefinition, type HelpSettingOptions } from "../vendor/kit-obsidian/help-setting";
import { createFoldStorage } from "./device";
import { settingBodyHost } from "../vendor/kit-obsidian/settings_walker";

/** Doku-Index und Issues auf GitHub; `open` nur für Tests. */
export function helpOptions(open?: (url: string) => void): HelpSettingOptions {
  return {
    ...githubHelpUrls("filename-sanitizer"),
    texts: { name: t("help.name"), desc: t("help.desc"), openDocs: t("help.openDocs"), reportIssue: t("help.reportIssue") },
    ...(open ? { open } : {}),
  };
}

type ItemDef = { name?: string; desc?: string; visible?: () => boolean; control?: { type: string; key: string }; render?: (setting: Setting) => void };
type GroupDef = { type: "group"; heading: string; items: ItemDef[] };

const RULES: readonly ReplaceableRule[] = ["colon-space", "colon", "question", "star", "quote", "lt", "gt", "backslash", "slash", "pipe", "hash", "caret", "bracket-open", "bracket-close"];
const LOG_GROUPS = ["origin", "effect", "environment", "frontmatter", "content"] as const;

export class FilenameSanitizerSettingTab extends PluginSettingTab {
  constructor(app: App, readonly plugin: FilenameSanitizerPlugin) {
    super(app, plugin);
  }

  /** Deklarativ: Obsidian rendert die Definitionen selbst.
   *  Hilfe-Zeile (UI-STANDARD §8) ist immer das ERSTE Element; Ersetzungen, Protokoll und Erweitert sind eingeklappt (Spec § 9). */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const defs: (GroupDef | ReturnType<typeof helpSettingDefinition>)[] = [
      helpSettingDefinition(helpOptions()),
      { type: "group", heading: t("group.repair"), items: [
        { name: t("set.linkWarning"), visible: () => !this.linkAuto(), render: (s) => { settingBodyHost(s).createDiv({ cls: "fsan-warning", text: t("set.linkWarning") }); } },
        { name: t("set.mode"), desc: t("set.modeDesc"), render: (s) => { this.renderMode(s); } },
        { name: t("set.device"), desc: t("set.deviceDesc"), render: (s) => { this.renderDevice(s); } },
        { name: t("set.notice"), desc: t("set.noticeDesc"), control: { type: "toggle", key: "showNotice" } },
        { name: t("set.alias"), desc: t("set.aliasDesc"), control: { type: "toggle", key: "aliasOldName" } },
      ] },
      { type: "group", heading: t("group.exceptions"), items: [
        { name: t("set.exceptions"), desc: t("set.exceptionsDesc"), render: (s) => { this.renderExceptions(s); } },
      ] },
      { type: "group", heading: t("group.replacements"), items: [
        { name: t("group.replacements"), render: (s) => { this.renderReplacements(s); } },
      ] },
      { type: "group", heading: t("group.log"), items: [
        { name: t("group.log"), render: (s) => { this.renderLog(s); } },
      ] },
      { type: "group", heading: t("group.advanced"), items: [
        { name: t("group.advanced"), render: (s) => { this.renderAdvanced(s); } },
      ] },
    ];
    return defs as unknown as SettingDefinitionItem[];
  }

  /** Host-Vertrag der deklarativen Controls (nativ ab 1.13 und im Kit-Walker). */
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings;
    switch (key) {
      case "showNotice": s.showNotice = Boolean(value); break;
      case "aliasOldName": s.aliasOldName = Boolean(value); break;
      case "mode": s.mode = value === "review" ? "review" : "auto"; break;
      case "exceptions": s.exceptions = typeof value === "string" ? value : ""; break;
      case "logFolder": {
        const r = checkFolderPath(typeof value === "string" ? value : "", s.policy);
        if (!r.ok) return;
        s.logFolder = r.folder; break;
      }
      case "logFrontmatterKeys": s.logFrontmatterKeys = String(value).split(",").map((k) => k.trim()).filter((k) => k !== ""); break;
      default: return;
    }
    await this.plugin.saveSettings();
    if (key === "exceptions") await this.plugin.engine.scanNow();
    this.refreshUi();
  }

  /** Eine Zahl aus einem Textfeld; `false`, wenn sie nicht gespeichert wurde. */
  async setNumber(key: NumberKey, raw: string): Promise<boolean> {
    const r = checkNumber(key, raw);
    if (!r.ok) return false;
    this.plugin.settings[key] = r.value;
    await this.plugin.saveSettings();
    return true;
  }

  /** Setzt den Protokollordner nur, wenn jedes Segment nach der Richtlinie ein gültiger Ordnername ist. */
  async setLogFolder(raw: string): Promise<{ ok: true } | { ok: false; bad: string }> {
    const r = checkFolderPath(raw, this.plugin.settings.policy);
    if (!r.ok) return r;
    await this.setControlValue("logFolder", r.folder);
    return { ok: true };
  }

  /** Ändert ein Richtlinien-Feld nur, wenn die Richtlinie danach gültig bleibt. */
  async setPolicyField(field: PolicyField, value: string | number): Promise<{ ok: true } | { ok: false; badChars: string }> {
    const r = trySetPolicy(this.plugin.settings.policy, field, value);
    if (!r.ok) return r;
    this.plugin.settings.policy = r.policy;
    await this.plugin.saveSettings();
    return { ok: true };
  }

  setDeviceRepairs(on: boolean): void { this.plugin.device.setRepairs(on); }
  setDeviceName(name: string): void { this.plugin.device.setName(name); }

  /** Baut die Definitionen neu auf (Obsidian ≥ 1.13, `minAppVersion` 1.15.0: es gibt keinen Rückfall mehr). */
  private refreshUi(): void {
    this.update();
  }

  private linkAuto(): boolean {
    const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
    return vault.getConfig?.("alwaysUpdateLinks") === true;
  }

  private renderMode(setting: Setting): void {
    setting.setName(t("set.mode")).setDesc(t("set.modeDesc"));
    setting.addDropdown((d) => {
      d.addOption("auto", t("set.mode.auto")).addOption("review", t("set.mode.review")).setValue(this.plugin.settings.mode);
      d.selectEl.setAttribute("aria-label", t("set.mode"));
      d.onChange((v) => { void this.setControlValue("mode", v); });
    });
  }

  private renderDevice(setting: Setting): void {
    setting.setName(t("set.device")).setDesc(t("set.deviceDesc"));
    setting.addToggle((tg) => {
      tg.setValue(this.plugin.device.repairs);
      tg.toggleEl.setAttribute("aria-label", t("set.device"));
      tg.onChange((v) => { this.setDeviceRepairs(v); });
    });
  }

  private renderExceptions(setting: Setting): void {
    setting.setName(t("set.exceptions")).setDesc(t("set.exceptionsDesc"));
    setting.addTextArea((ta) => {
      ta.setValue(this.plugin.settings.exceptions);
      ta.inputEl.rows = 5;
      ta.inputEl.setAttribute("aria-label", t("set.exceptions"));
      ta.inputEl.addEventListener("blur", () => { if (ta.getValue() !== this.plugin.settings.exceptions) void this.setControlValue("exceptions", ta.getValue()); });
    });
  }

  /** Eine eingeklappte Sektion in einem Einstellungs-Eintrag. */
  /** Eingeklappt, bis jemand sie öffnet; was jemand auf- oder zugeklappt hat, bleibt über jedes Neuzeichnen und jeden Neustart. */
  private section(setting: Setting, key: string, title: string, build: (body: HTMLElement) => void): void {
    const host = settingBodyHost(setting);
    build(collapsibleSection(host, { title, defaultCollapsed: true, key, storage: createFoldStorage(this.app) }));
  }

  private note(parent: HTMLElement): HTMLElement {
    return parent.createDiv({ cls: "fsan-note" });
  }

  private renderReplacements(setting: Setting): void {
    this.section(setting, "replacements", t("fold.replacements"), (body) => {
      body.createDiv({ cls: "fsan-note", text: t("set.replacementsDesc") });
      for (const rule of RULES) {
        const row = new Setting(body).setName(t(`rule.${rule}`));
        const msg = this.note(row.descEl);
        const commit = async (value: string, input: HTMLInputElement): Promise<void> => {
          const r = await this.setPolicyField(rule, value);
          msg.setText(r.ok ? "" : t("set.invalidReplacement", r.badChars));
          msg.toggleClass("fsan-warning", !r.ok);
          if (!r.ok) input.value = this.plugin.settings.policy.replacements[rule];
        };
        row.addText((tx) => {
          tx.setValue(this.plugin.settings.policy.replacements[rule]);
          tx.inputEl.setAttribute("aria-label", t(`rule.${rule}`));
          tx.inputEl.addEventListener("blur", () => { if (tx.getValue() !== this.plugin.settings.policy.replacements[rule]) void commit(tx.getValue(), tx.inputEl); });
        });
        row.addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip(t("set.reset")).onClick(() => {
          void this.setPolicyField(rule, DEFAULT_FILENAME_POLICY.replacements[rule]).then(() => { this.refreshUi(); });
        }));
      }
    });
  }

  private renderLog(setting: Setting): void {
    this.section(setting, "log", t("fold.log"), (body) => {
      const s = this.plugin.settings;
      const folderRow = new Setting(body).setName(t("set.logFolder")).setDesc(t("set.logFolderDesc"));
      const folderMsg = this.note(folderRow.descEl);
      folderRow.addText((tx) => {
        tx.setValue(s.logFolder);
        tx.inputEl.setAttribute("aria-label", t("set.logFolder"));
        new FolderSuggest(this.app, tx.inputEl);
        tx.inputEl.addEventListener("blur", () => {
          if (tx.getValue().trim() === s.logFolder) return;
          void this.setLogFolder(tx.getValue()).then((r) => {
            folderMsg.setText(r.ok ? "" : t("set.invalidFolder", r.bad));
            folderMsg.toggleClass("fsan-warning", !r.ok);
            if (!r.ok) tx.setValue(this.plugin.settings.logFolder);
          });
        });
      });
      new Setting(body).setName(t("set.deviceName")).setDesc(t("set.deviceNameDesc")).addText((tx) => {
        tx.setValue(this.plugin.device.name);
        tx.inputEl.setAttribute("aria-label", t("set.deviceName"));
        tx.inputEl.addEventListener("blur", () => { this.setDeviceName(tx.getValue()); });
      });
      this.numberRow(body, "logKeepMonths", t("set.logKeep"), t("set.logKeepDesc"));
      for (const g of LOG_GROUPS) {
        new Setting(body).setName(t(`set.log.${g}`)).setDesc(t(`set.log.${g}Desc`)).addToggle((tg) => {
          tg.setValue(s.logFields[g]);
          tg.toggleEl.setAttribute("aria-label", t(`set.log.${g}`));
          tg.onChange((v) => { s.logFields[g] = v; void this.plugin.saveSettings(); });
        });
      }
      new Setting(body).setName(t("set.logFrontmatterKeys")).setDesc(t("set.logFrontmatterKeysDesc")).addText((tx) => {
        tx.setValue(s.logFrontmatterKeys.join(", "));
        tx.inputEl.setAttribute("aria-label", t("set.logFrontmatterKeys"));
        tx.inputEl.addEventListener("blur", () => { void this.setControlValue("logFrontmatterKeys", tx.getValue()); });
      });
      this.numberRow(body, "logContentChars", t("set.logContentChars"), t("set.logContentCharsDesc"));
    });
  }

  private renderAdvanced(setting: Setting): void {
    this.section(setting, "advanced", t("fold.advanced"), (body) => {
      this.numberRow(body, "quietMs", t("set.quiet"), t("set.quietDesc"));
      this.policyRow(body, "maxBytes", t("set.maxBytes"), t("set.maxBytesDesc"));
      this.policyRow(body, "extraChars", t("set.extraChars"), t("set.extraCharsDesc"));
      this.policyRow(body, "extraReplacement", t("set.extraReplacement"), "");
    });
  }

  private numberRow(parent: HTMLElement, key: NumberKey, name: string, desc: string): void {
    const row = new Setting(parent).setName(name).setDesc(desc);
    const msg = this.note(row.descEl);
    row.addText((tx) => {
      tx.setValue(String(this.plugin.settings[key]));
      tx.inputEl.setAttribute("aria-label", name);
      tx.inputEl.inputMode = "numeric";
      tx.inputEl.addEventListener("blur", () => {
        void this.setNumber(key, tx.getValue()).then((ok) => {
          msg.setText(ok ? "" : t("set.invalidValue", tx.getValue()));
          msg.toggleClass("fsan-warning", !ok);
          if (!ok) tx.setValue(String(this.plugin.settings[key]));
        });
      });
    });
  }

  private policyRow(parent: HTMLElement, field: "maxBytes" | "extraChars" | "extraReplacement", name: string, desc: string): void {
    const row = new Setting(parent).setName(name);
    if (desc !== "") row.setDesc(desc);
    const msg = this.note(row.descEl);
    const current = (): string => String(this.plugin.settings.policy[field]);
    row.addText((tx) => {
      tx.setValue(current());
      tx.inputEl.setAttribute("aria-label", name);
      tx.inputEl.addEventListener("blur", () => {
        const raw = tx.getValue();
        if (field === "maxBytes" && !/^\d+$/.test(raw.trim())) { msg.setText(t("set.invalidValue", raw)); msg.toggleClass("fsan-warning", true); tx.setValue(current()); return; }
        void this.setPolicyField(field, field === "maxBytes" ? Number(raw.trim()) : raw).then((r) => {
          msg.setText(r.ok ? "" : field === "maxBytes" ? t("set.invalidValue", raw) : t("set.invalidReplacement", r.badChars));
          msg.toggleClass("fsan-warning", !r.ok);
          if (!r.ok) tx.setValue(current());
        });
      });
    });
  }
}
