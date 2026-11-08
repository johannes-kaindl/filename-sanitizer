import type { ReviewChange } from "../vendor/kit-obsidian/review-list";
import type { RedlineSegment } from "../vendor/kit-obsidian/redline";
import { t } from "../vendor/kit/i18n";
import { orderForRepair } from "./decide";
import type { ReviewEntry } from "./review-entry";

const lastSegment = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const dirOf = (p: string): string => { const i = p.lastIndexOf("/"); return i < 0 ? "/" : p.slice(0, i); };

/** Alter und neuer Name als Redline: gleicher Anfang und gleiches Ende bleiben, die Mitte ist gestrichen und eingefügt. */
export function nameDiff(oldName: string, newName: string): RedlineSegment[] {
  if (oldName === newName) return [{ kind: "same", text: oldName }];
  let head = 0;
  while (head < oldName.length && head < newName.length && oldName.charAt(head) === newName.charAt(head)) head++;
  let tail = 0;
  while (tail < oldName.length - head && tail < newName.length - head && oldName.charAt(oldName.length - 1 - tail) === newName.charAt(newName.length - 1 - tail)) tail++;
  const out: RedlineSegment[] = [];
  const push = (kind: RedlineSegment["kind"], text: string): void => { if (text !== "") out.push({ kind, text }); };
  push("same", oldName.slice(0, head));
  push("del", oldName.slice(head, oldName.length - tail));
  push("ins", newName.slice(head, newName.length - tail));
  push("same", oldName.slice(oldName.length - tail));
  return out;
}

/** Karten der Prüfliste: Haken = `accepted`, kein Haken = `rejected` (bleibt gelistet). Dubletten tragen nie einen Haken. */
export function reviewItems(entries: readonly ReviewEntry[], ticks: ReadonlySet<string>): ReviewChange[] {
  return entries.map((entry) => ({
    kind: "change",
    id: entry.path,
    author: t(`review.reason.${entry.reason}`),
    when: dirOf(entry.path),
    changeKind: "substitution",
    segments: nameDiff(lastSegment(entry.path), lastSegment(entry.target)),
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
