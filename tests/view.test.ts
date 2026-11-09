import { describe, expect, it } from "vitest";
import { ItemView } from "obsidian";
import { SanitizerView, VIEW_TYPE_SANITIZER, addKeepAlways } from "../src/obsidian/view";
import type FilenameSanitizerPlugin from "../src/main";
import { setLang, t } from "../src/vendor/kit/i18n";
import "../src/i18n/strings";
import { makeFakeEl } from "./vendor/kit/obsidian-mock";

describe("SanitizerView", () => {
  it("has its own view type and builds both tabs", async () => {
    const entries: never[] = [];
    const plugin = { engine: { pending: () => entries, onChange: () => () => undefined, applyReview: () => Promise.resolve(), scanNow: () => Promise.resolve() }, device: { repairs: true }, settings: { exceptions: "" }, logStore: { read: () => Promise.resolve([]) }, saveSettings: () => Promise.resolve(), app: {} } as unknown as FilenameSanitizerPlugin;
    const View = SanitizerView as unknown as new (leaf: unknown, p: FilenameSanitizerPlugin) => SanitizerView & { contentEl: unknown };
    const view = new View({}, plugin);
    (view as unknown as { contentEl: unknown }).contentEl = makeFakeEl();
    expect(view.getViewType()).toBe(VIEW_TYPE_SANITIZER);
    expect(view).toBeInstanceOf(ItemView);
    await view.onOpen();
    const root = (view as unknown as { contentEl: { children: unknown[] } }).contentEl;
    expect(root.children).toHaveLength(2);
    view.showTab("log");
    await view.onClose();
  });
  it("every lock reason and review reason has a text in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      setLang(lang);
      for (const k of ["device-off", "link-setting", "stalled", "nothing"]) expect(t(`review.locked.${k}`)).not.toBe(`review.locked.${k}`);
      for (const k of ["mode", "link-setting", "legacy", "repeat", "identical", "stalled"]) expect(t(`review.reason.${k}`)).not.toBe(`review.reason.${k}`);
      for (const k of ["repariert", "identisch", "kollision", "fehlgeschlagen", "vorgemerkt", "bestätigt", "übersprungen", "wiederholt"]) expect(t(`log.event.${k}`)).not.toBe(`log.event.${k}`);
    }
    setLang("en");
  });
  it("addKeepAlways appends one exact line, skips a duplicate and refuses a path no line can say", () => {
    expect(addKeepAlways("", "a: b.md")).toEqual({ kind: "added", exceptions: "/a: b.md" });
    expect(addKeepAlways("Archiv/\n", "a: b.md")).toEqual({ kind: "added", exceptions: "Archiv/\n/a: b.md" });
    expect(addKeepAlways("/a: b.md", "a: b.md")).toEqual({ kind: "present" });
    for (const path of [" a: b.md", "a: b.md ", "x//a: b.md", "x/a:\nb.md", ""]) expect(addKeepAlways("Archiv/", path)).toEqual({ kind: "impossible" });
  });
  it("the not-expressible notice exists in both languages", () => {
    for (const lang of ["en", "de"] as const) { setLang(lang); expect(t("notice.keepImpossible", "x")).not.toBe("notice.keepImpossible"); }
    setLang("en");
  });
});
