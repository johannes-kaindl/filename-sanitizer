import { DEFAULT_FILENAME_POLICY, validatePolicy, type FilenamePolicy, type ReplaceableRule } from "../vendor/kit/filename-policy";
import { DEFAULT_QUIET_MS } from "./constants";

export type RepairMode = "auto" | "review";

export interface LogFields { origin: boolean; effect: boolean; environment: boolean; frontmatter: boolean; content: boolean }

export interface SanitizerSettings {
  mode: RepairMode;
  showNotice: boolean;
  aliasOldName: boolean;
  /** Pfadmuster in .gitignore-Art, Zeilen getrennt. */
  exceptions: string;
  policy: FilenamePolicy;
  quietMs: number;
  logFolder: string;
  /** 0 = unbegrenzt. */
  logKeepMonths: number;
  logFields: LogFields;
  logFrontmatterKeys: string[];
  /** Anzahl Zeichen des Dateitexts, wenn `logFields.content` an ist. */
  logContentChars: number;
}

export const DEFAULT_SETTINGS: SanitizerSettings = {
  mode: "auto",
  showNotice: true,
  aliasOldName: true,
  exceptions: "",
  policy: DEFAULT_FILENAME_POLICY,
  quietMs: DEFAULT_QUIET_MS,
  logFolder: "Filename Sanitizer/Log",
  logKeepMonths: 12,
  logFields: { origin: true, effect: true, environment: true, frontmatter: true, content: false },
  logFrontmatterKeys: ["agent", "model", "session_id", "created_by", "source"],
  logContentChars: 200,
};

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const bool = (x: unknown, d: boolean): boolean => (typeof x === "boolean" ? x : d);
const str = (x: unknown, d: string): string => (typeof x === "string" ? x : d);
const natural = (x: unknown, d: number, min = 0): number => (typeof x === "number" && Number.isInteger(x) && x >= min ? x : d);

function loadPolicy(raw: unknown): FilenamePolicy {
  const r = isObj(raw) ? raw : {};
  const rr = isObj(r.replacements) ? r.replacements : {};
  const replacements = { ...DEFAULT_FILENAME_POLICY.replacements } as Record<ReplaceableRule, string>;
  for (const k of Object.keys(replacements) as ReplaceableRule[]) if (typeof rr[k] === "string") replacements[k] = rr[k];
  let policy: FilenamePolicy = {
    replacements,
    extraChars: str(r.extraChars, ""),
    extraReplacement: str(r.extraReplacement, ""),
    maxBytes: typeof r.maxBytes === "number" ? r.maxBytes : 0,
  };
  for (let round = 0; round < 3; round++) {
    const problems = validatePolicy(policy);
    if (problems.length === 0) return policy;
    const fixed = { ...policy.replacements } as Record<ReplaceableRule, string>;
    let { extraReplacement, maxBytes } = policy;
    for (const p of problems) {
      if (p.field === "maxBytes") maxBytes = 0;
      else if (p.field === "extraReplacement") extraReplacement = "";
      else fixed[p.field] = DEFAULT_FILENAME_POLICY.replacements[p.field];
    }
    // Ein Zusatzzeichen, das eine Vorgabe-Ersetzung selbst enthält, ließe sich nicht beheben: es entfällt.
    policy = { replacements: fixed, extraChars: round === 1 ? "" : policy.extraChars, extraReplacement, maxBytes };
  }
  return DEFAULT_FILENAME_POLICY;
}

/** Liest gespeicherte Einstellungen Feld für Feld; ungültige Werte fallen einzeln auf die Vorgabe zurück. */
export function loadSettings(raw: unknown): SanitizerSettings {
  const r = isObj(raw) ? raw : {};
  const lf = isObj(r.logFields) ? r.logFields : {};
  const d = DEFAULT_SETTINGS;
  const folder = typeof r.logFolder === "string" && r.logFolder.trim() !== "" ? r.logFolder.trim() : d.logFolder;
  const keys = Array.isArray(r.logFrontmatterKeys) && r.logFrontmatterKeys.every((k) => typeof k === "string") ? r.logFrontmatterKeys.slice() : d.logFrontmatterKeys.slice();
  return {
    mode: r.mode === "review" || r.mode === "auto" ? r.mode : d.mode,
    showNotice: bool(r.showNotice, d.showNotice),
    aliasOldName: bool(r.aliasOldName, d.aliasOldName),
    exceptions: str(r.exceptions, d.exceptions),
    policy: loadPolicy(r.policy),
    quietMs: natural(r.quietMs, d.quietMs),
    logFolder: folder,
    logKeepMonths: natural(r.logKeepMonths, d.logKeepMonths),
    logFields: {
      origin: bool(lf.origin, d.logFields.origin),
      effect: bool(lf.effect, d.logFields.effect),
      environment: bool(lf.environment, d.logFields.environment),
      frontmatter: bool(lf.frontmatter, d.logFields.frontmatter),
      content: bool(lf.content, d.logFields.content),
    },
    logFrontmatterKeys: keys,
    logContentChars: natural(r.logContentChars, d.logContentChars),
  };
}

export type PolicyField = ReplaceableRule | "extraReplacement" | "maxBytes" | "extraChars";

/** Setzt ein Richtlinien-Feld, wenn die Richtlinie danach gültig bleibt; sonst nennt es die Zeichen, die sie ablehnt. */
export function trySetPolicy(policy: FilenamePolicy, field: PolicyField, value: string | number): { ok: true; policy: FilenamePolicy } | { ok: false; badChars: string } {
  const replacements = { ...policy.replacements } as Record<ReplaceableRule, string>;
  let { maxBytes, extraChars, extraReplacement } = policy;
  if (field === "maxBytes") maxBytes = typeof value === "number" ? value : Number.NaN;
  else if (field === "extraChars") extraChars = String(value);
  else if (field === "extraReplacement") extraReplacement = String(value);
  else replacements[field] = String(value);
  const next: FilenamePolicy = { replacements, extraChars, extraReplacement, maxBytes };
  const problems = validatePolicy(next);
  if (problems.length === 0) return { ok: true, policy: next };
  const own = problems.find((p) => p.field === field) ?? problems[0];
  return { ok: false, badChars: own.badChars };
}
