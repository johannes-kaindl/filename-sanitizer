import { applyPolicy, checkSegment, type SegmentKind } from "../vendor/kit/filename-policy";
import { FILENAME_SANITIZER_API_VERSION, type ApiError, type FilenameSanitizerApi, type NameCheck, type SanitizeResult } from "../vendor/kit/filename-sanitizer-source";
import type { SanitizerSettings } from "./settings";

const invalid = (message: string): ApiError => ({ error: "invalid-input", message });

function kindOf(opts: { kind?: unknown } | undefined): SegmentKind | ApiError {
  const k = opts?.kind;
  if (k === undefined) return "file";
  return k === "file" || k === "folder" ? k : invalid("kind must be \"file\" or \"folder\"");
}

/** Plugin-API v1: synchron, Fehler sind Werte. Das Protokoll schreibt `logChange` im Hintergrund; sein Scheitern ändert nichts am Ergebnis. */
export function createApi(deps: { settings: () => SanitizerSettings; logChange: (caller: string, before: string, result: SanitizeResult) => void }): FilenameSanitizerApi {
  return {
    version: FILENAME_SANITIZER_API_VERSION,
    sanitizeName(name, opts) {
      if (typeof name !== "string" || name === "") return invalid("name must be a non-empty string");
      const caller = (opts as { caller?: unknown } | undefined)?.caller;
      if (typeof caller !== "string" || caller.trim() === "") return invalid("caller must be a non-empty string");
      const kind = kindOf(opts);
      if (typeof kind !== "string") return kind;
      const r = applyPolicy(name, deps.settings().policy, kind);
      const result: SanitizeResult = { name: r.name, changed: r.changed, hits: r.hits };
      if (result.changed) {
        try { deps.logChange(caller.trim(), name, result); } catch { /* das Protokoll darf den Schreibweg nicht stören */ }
      }
      return result;
    },
    checkName(name, opts): NameCheck | ApiError {
      if (typeof name !== "string" || name === "") return invalid("name must be a non-empty string");
      const kind = kindOf(opts);
      if (typeof kind !== "string") return kind;
      const hits = checkSegment(name, deps.settings().policy, kind);
      return { valid: hits.length === 0, hits };
    },
  };
}
