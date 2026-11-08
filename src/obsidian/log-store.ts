import type { App } from "obsidian";
import { expiredLogFiles, logFileName, parseLogLine, type LogInput } from "../core/log-entry";
import type { SanitizerSettings } from "../core/settings";
import { joinVaultPath, normalizeVaultDir } from "../vendor/kit/vault-path";
import type { LogStore } from "./engine";

/** Protokoll im Vault: eine `.jsonl` je Gerät und Monat. Fehler hier brechen nie eine Reparatur ab. */
export function createLogStore(app: App, deps: { settings: () => SanitizerSettings; deviceName: () => string; onError?: (e: unknown) => void }): LogStore {
  const adapter = app.vault.adapter;
  let tail: Promise<void> = Promise.resolve();
  const folder = (): string => normalizeVaultDir(deps.settings().logFolder);

  async function ensureFolder(dir: string): Promise<void> {
    let acc = "";
    for (const part of dir.split("/")) {
      acc = acc ? `${acc}/${part}` : part;
      if (!(await adapter.exists(acc))) await adapter.mkdir(acc);
    }
  }

  return {
    write(line, time) {
      const dir = folder();
      const path = joinVaultPath(dir, logFileName(deps.deviceName(), time));
      tail = tail.then(async () => {
        if (dir) await ensureFolder(dir);
        await adapter.append(path, `${line}\n`);
      }).catch((e) => { deps.onError?.(e); });
    },

    async read(limit) {
      await tail;
      const dir = folder();
      try {
        if (!(await adapter.exists(dir))) return [];
        const listing = await adapter.list(dir);
        const out: LogInput[] = [];
        for (const file of listing.files.filter((f) => f.endsWith(".jsonl"))) {
          const text = await adapter.read(file);
          for (const l of text.split("\n")) {
            if (l.trim() === "") continue;
            const parsed = parseLogLine(l);
            if (parsed) out.push(parsed);
          }
        }
        return out.sort((a, b) => b.time - a.time).slice(0, limit);
      } catch (e) { deps.onError?.(e); return []; }
    },

    async rotate(now) {
      const dir = folder();
      try {
        if (!(await adapter.exists(dir))) return;
        const listing = await adapter.list(dir);
        const byName = new Map(listing.files.map((f) => [f.slice(f.lastIndexOf("/") + 1), f]));
        for (const name of expiredLogFiles([...byName.keys()], now, deps.settings().logKeepMonths)) await adapter.remove(byName.get(name)!);
      } catch (e) { deps.onError?.(e); }
    },
  };
}
