import { applyPolicy, checkSegment, numberedName, type FilenameHit, type FilenamePolicy } from "../vendor/kit/filename-policy";
import { matchIgnore, parsePatterns, type ParsedPatterns } from "../vendor/kit/ignore";
import { joinVaultPath, vaultDirname } from "../vendor/kit/vault-path";
import type { SanitizerSettings } from "./settings";

export type Trigger = "create" | "rename" | "modify" | "start" | "list";
export type TargetState = "free" | "same-content" | "different" | "folder-exists";
export type ReviewReason = "mode" | "link-setting" | "legacy" | "repeat";
export type Decision =
  | { kind: "none" }
  | { kind: "exception" }
  | { kind: "rename"; target: string; hits: FilenameHit[] }
  | { kind: "identical"; target: string }
  | { kind: "review"; reason: ReviewReason; hits: FilenameHit[] };

/** Obergrenze der Nummern-Suche; danach landet der Eintrag in der Prüfliste statt in einer Endlosschleife. */
const MAX_NUMBER = 999;

let cachedText: string | null = null;
let cachedRules: ParsedPatterns = { rules: [], invalid: [] };
function rulesFor(patterns: string): ParsedPatterns {
  if (patterns !== cachedText) { cachedRules = parsePatterns(patterns); cachedText = patterns; }
  return cachedRules;
}

/** Ausnahme, wenn ein Muster den Pfad selbst oder einen seiner Ordner trifft (`matchIgnore` kennt nur den genauen Pfad). */
export function isException(path: string, patterns: string): boolean {
  const { rules } = rulesFor(patterns);
  if (rules.length === 0) return false;
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) if (matchIgnore(rules, parts.slice(0, i).join("/")) !== null) return true;
  return false;
}

export function targetFor(path: string, name: string): string {
  return joinVaultPath(vaultDirname(path), name);
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function decide(input: {
  path: string; isFolder: boolean; settings: SanitizerSettings; linkAuto: boolean; inSnapshot: boolean;
  repeatBlocked: boolean; trigger: Trigger; targetState: (target: string) => TargetState;
}): Decision {
  const { path, isFolder, settings, trigger } = input;
  const kind = isFolder ? "folder" : "file";
  const name = lastSegment(path);
  const hits = checkSegment(name, settings.policy, kind);
  if (hits.length === 0) return { kind: "none" };
  if (isException(path, settings.exceptions)) return { kind: "exception" };

  const review = (reason: ReviewReason): Decision => ({ kind: "review", reason, hits });
  const manual = trigger === "list";
  if (input.inSnapshot && !manual) return review("legacy");
  if (settings.mode === "review" && !manual) return review("mode");
  if (input.repeatBlocked && !manual) return review("repeat");
  if (!input.linkAuto) return review("link-setting");

  const fixed = applyPolicy(name, settings.policy, kind).name;
  for (let n = 1; n <= MAX_NUMBER; n++) {
    const target = targetFor(path, numberedName(fixed, kind, n));
    const state = input.targetState(target);
    if (state === "free") return { kind: "rename", target, hits };
    if (state === "same-content" && !isFolder) return { kind: "identical", target };
  }
  return review("repeat");
}

/** Ordner vor ihrem Inhalt: flach vor tief, bei gleicher Tiefe Ordner vor Dateien. Stabil. */
export function orderForRepair<T extends { path: string; isFolder: boolean }>(items: T[]): T[] {
  const depth = (p: string): number => p.split("/").length;
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => depth(a.item.path) - depth(b.item.path) || Number(b.item.isFolder) - Number(a.item.isFolder) || a.i - b.i)
    .map((x) => x.item);
}

/** Pfade mit einem Fund beim ersten Start eines Geräts: dieser Altbestand wird nie ungefragt umbenannt. */
export function initialSnapshot(paths: { path: string; isFolder: boolean }[], policy: FilenamePolicy): string[] {
  return paths.filter((p) => checkSegment(lastSegment(p.path), policy, p.isFolder ? "folder" : "file").length > 0).map((p) => p.path);
}
