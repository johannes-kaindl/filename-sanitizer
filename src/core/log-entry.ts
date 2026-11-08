import { applyPolicy, DEFAULT_FILENAME_POLICY } from "../vendor/kit/filename-policy";
import type { LogFields, RepairMode } from "./settings";

export type LogEvent = "repariert" | "identisch" | "kollision" | "fehlgeschlagen" | "vorgemerkt" | "bestätigt" | "übersprungen" | "wiederholt";
const EVENTS: readonly string[] = ["repariert", "identisch", "kollision", "fehlgeschlagen", "vorgemerkt", "bestätigt", "übersprungen", "wiederholt"];

export interface LogInput {
  time: number;
  event: LogEvent;
  oldPath: string;
  newPath?: string;
  rules: string[];
  trigger: string;
  caller?: string;
  device: string;
  mode: RepairMode;
  origin?: { ctime: number; mtime: number; size: number; secondsToRepair: number; burstCount: number };
  effect?: { aliasSet: boolean; linksChanged?: number };
  environment?: { pluginVersion: string; obsidianVersion: string; platform: string };
  frontmatter?: Record<string, unknown>;
  content?: string;
  message?: string;
}

/** Schema-Version der Protokollzeilen. */
export const LOG_SCHEMA = 1;

/** Eine JSON-Zeile ohne Zeilenumbruch. Gruppen, die in `fields` aus sind, werden nicht geschrieben. */
export function toLogLine(input: LogInput, fields: LogFields): string {
  const o: Record<string, unknown> = {
    v: LOG_SCHEMA, time: new Date(input.time).toISOString(), event: input.event, oldPath: input.oldPath,
    newPath: input.newPath, rules: input.rules, trigger: input.trigger, caller: input.caller, device: input.device, mode: input.mode,
  };
  if (fields.origin) o.origin = input.origin;
  if (fields.effect) o.effect = input.effect;
  if (fields.environment) o.environment = input.environment;
  if (fields.frontmatter) o.frontmatter = input.frontmatter;
  if (fields.content) o.content = input.content;
  if (input.message !== undefined) o.message = input.message;
  return JSON.stringify(o);
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);

/** `null` bei beschädigter oder fremder Zeile; ein Protokoll mit einer kaputten Zeile bleibt lesbar. */
export function parseLogLine(line: string): LogInput | null {
  let o: unknown;
  try { o = JSON.parse(line); } catch { return null; }
  if (!isObj(o) || o.v !== LOG_SCHEMA) return null;
  const time = typeof o.time === "string" ? Date.parse(o.time) : NaN;
  if (Number.isNaN(time)) return null;
  if (typeof o.event !== "string" || !EVENTS.includes(o.event)) return null;
  if (typeof o.oldPath !== "string" || typeof o.trigger !== "string" || typeof o.device !== "string") return null;
  if (!Array.isArray(o.rules) || !o.rules.every((r) => typeof r === "string")) return null;
  if (o.mode !== "auto" && o.mode !== "review") return null;
  const out: LogInput = { time, event: o.event as LogEvent, oldPath: o.oldPath, rules: o.rules, trigger: o.trigger, device: o.device, mode: o.mode };
  if (typeof o.newPath === "string") out.newPath = o.newPath;
  if (typeof o.caller === "string") out.caller = o.caller;
  if (isObj(o.origin)) out.origin = o.origin as unknown as NonNullable<LogInput["origin"]>;
  if (isObj(o.effect)) out.effect = o.effect as unknown as NonNullable<LogInput["effect"]>;
  if (isObj(o.environment)) out.environment = o.environment as unknown as NonNullable<LogInput["environment"]>;
  if (isObj(o.frontmatter)) out.frontmatter = o.frontmatter;
  if (typeof o.content === "string") out.content = o.content;
  if (typeof o.message === "string") out.message = o.message;
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `<Gerät>-<JJJJ>-<MM>.jsonl`; der Gerätename läuft durch die Richtlinie, damit die Datei selbst zulässig ist. */
export function logFileName(device: string, time: number): string {
  const d = new Date(time);
  const safe = applyPolicy(device.trim() || "device", DEFAULT_FILENAME_POLICY, "folder").name.replace(/\.+$/, "") || "device";
  return `${safe}-${d.getFullYear()}-${pad2(d.getMonth() + 1)}.jsonl`;
}

/** Protokolldateien, deren Monat mehr als `keepMonths` zurückliegt; 0 behält alles, fremde Namen bleiben. */
export function expiredLogFiles(names: string[], now: number, keepMonths: number): string[] {
  if (keepMonths <= 0) return [];
  const d = new Date(now);
  const current = d.getFullYear() * 12 + d.getMonth();
  return names.filter((n) => {
    const m = /^.+-(\d{4})-(\d{2})\.jsonl$/.exec(n);
    if (!m) return false;
    const month = Number(m[2]);
    if (month < 1 || month > 12) return false;
    return current - (Number(m[1]) * 12 + month - 1) > keepMonths;
  });
}

export function summarizeBurst(items: { oldName: string; newName: string }[]): { count: number; single?: { oldName: string; newName: string } } {
  if (items.length === 1) return { count: 1, single: items[0] };
  return { count: items.length };
}
