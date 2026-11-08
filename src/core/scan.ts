import { decide, orderForRepair, type Decision, type TargetState, type Trigger } from "./decide";
import type { SanitizerSettings } from "./settings";

export interface ScanEntry { path: string; isFolder: boolean }

/** Entscheidungen für alle Einträge mit Fund, in Reparaturreihenfolge (Ordner zuerst, flach vor tief). */
export function scanDecisions<T extends ScanEntry>(
  entries: T[],
  ctx: { settings: SanitizerSettings; linkAuto: boolean; snapshot: ReadonlySet<string>; trigger: Trigger; targetState: (target: string) => TargetState; isBlocked: (path: string) => boolean },
): { entry: T; decision: Decision }[] {
  const out: { entry: T; decision: Decision }[] = [];
  for (const entry of orderForRepair(entries)) {
    const decision = decide({ path: entry.path, isFolder: entry.isFolder, settings: ctx.settings, linkAuto: ctx.linkAuto, inSnapshot: ctx.snapshot.has(entry.path), repeatBlocked: ctx.isBlocked(entry.path), trigger: ctx.trigger, targetState: ctx.targetState });
    if (decision.kind !== "none") out.push({ entry, decision });
  }
  return out;
}
