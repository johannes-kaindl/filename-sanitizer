import type { ReviewChange } from "../vendor/kit-obsidian/review-list";
import { t } from "../vendor/kit/i18n";
import { affixDiffSegments } from "../vendor/kit/word-diff";
import { orderForRepair } from "./decide";
import type { ReviewEntry } from "./review-entry";

const lastSegment = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => { const i = p.lastIndexOf("/"); return i < 0 ? "/" : p.slice(0, i); };

/** Karten der Prüfliste: Haken = `accepted`, kein Haken = `rejected` (bleibt gelistet). Dubletten tragen nie einen Haken. */
export function reviewItems(entries: readonly ReviewEntry[], ticks: ReadonlySet<string>): ReviewChange[] {
  return entries.map((entry) => ({
    kind: "change",
    id: entry.path,
    author: t(`review.reason.${entry.reason}`),
    when: dirOf(entry.path),
    changeKind: "substitution",
    segments: affixDiffSegments(lastSegment(entry.path), lastSegment(entry.target)),
    decision: entry.reason !== "identical" && ticks.has(entry.path) ? "accepted" : "rejected",
  }));
}

export type ApplyGate = { ok: true; paths: string[] } | { ok: false; why: "device-off" | "link-setting" | "stalled" | "nothing" };

/** Darf „Umbenennen“ auslösen? Gesperrt, wenn das Gerät nicht repariert oder ein angehakter Eintrag an der Link-Einstellung oder einer festgefahrenen Automatik hängt. */
export function applyGate(entries: readonly ReviewEntry[], ticks: ReadonlySet<string>, env: { deviceRepairs: boolean }): ApplyGate {
  if (!env.deviceRepairs) return { ok: false, why: "device-off" };
  const ticked = entries.filter((e) => ticks.has(e.path) && e.reason !== "identical");
  if (ticked.some((e) => e.reason === "link-setting")) return { ok: false, why: "link-setting" };
  if (ticked.some((e) => e.reason === "stalled")) return { ok: false, why: "stalled" };
  if (ticked.length === 0) return { ok: false, why: "nothing" };
  return { ok: true, paths: orderForRepair(ticked).map((e) => e.path) };
}
