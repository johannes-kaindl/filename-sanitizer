import type { LogEvent, LogInput } from "./log-entry";

export interface LogRow {
  key: string;
  time: number;
  event: LogEvent;
  oldPath: string;
  newPath?: string;
  device: string;
  caller?: string;
  rules: string[];
  trigger: string;
  message?: string;
}

export interface LogFilter { device?: string; folder?: string; event?: LogEvent }

const dirOf = (p: string): string => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
const inFolder = (path: string | undefined, folder: string): boolean => {
  if (path === undefined) return false;
  const d = dirOf(path);
  return d === folder || d.startsWith(`${folder}/`);
};

/** Protokollzeilen, neueste zuerst, nach Gerät, Ordner (alter oder neuer Pfad liegt darin) und Ereignis gefiltert. */
export function logRows(entries: readonly LogInput[], filter: LogFilter): LogRow[] {
  const folder = filter.folder?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  return entries
    .filter((e) => (filter.device === undefined || e.device === filter.device) && (filter.event === undefined || e.event === filter.event) && (folder === "" || inFolder(e.oldPath, folder) || inFolder(e.newPath, folder)))
    .map((e, i) => ({ key: `${e.time}-${i}`, time: e.time, event: e.event, oldPath: e.oldPath, newPath: e.newPath, device: e.device, caller: e.caller, rules: e.rules, trigger: e.trigger, message: e.message }))
    .sort((a, b) => b.time - a.time);
}

/** Was in den Auswahllisten stehen kann: nur Geräte und Ereignisse, die im Protokoll vorkommen. */
export function logFilterOptions(entries: readonly LogInput[]): { devices: string[]; events: LogEvent[] } {
  return { devices: [...new Set(entries.map((e) => e.device))].sort((a, b) => a.localeCompare(b)), events: [...new Set(entries.map((e) => e.event))].sort() };
}
