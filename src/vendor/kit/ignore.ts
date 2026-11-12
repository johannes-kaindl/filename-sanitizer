// vendored from code-kit@0.64.0, src/ts/pure/ignore.ts — do not hand-edit; re-vendor via tools/sync-kit.sh
/** Ignore patterns in `.gitignore` style, applied to FOLDER paths only.
 *
 *  Lifted from `shadow-tree/src/core/ignore.ts` (shadow-tree wave 14, spec § 5); the second
 *  consumer is Ghostline. shadow-tree itself still carries its own copy — swapping it over is a
 *  separate job. Pure on purpose: no file system, no vault, so a folder-hiding plugin and a
 *  folder-tree plugin read the same rules the same way.
 *
 *  Syntax: one rule per line; `#` comment; `*` inside a segment, `**` across segments, `?` one
 *  character; without a slash the rule matches the folder name at any depth, with a slash the
 *  path from the vault root (leading `/` optional); a trailing `/` has no effect; `!` negates,
 *  the last matching rule wins. Ranges `[abc]` are deliberately literal. */
export interface IgnoreRule { source: string; negate: boolean; anchored: boolean; regex: RegExp; }
export interface ParsedPatterns { rules: IgnoreRule[]; invalid: string[]; }

/** Trim, collapse doubled slashes, strip slashes at the edges; the root becomes "". */
export function normalizeFolderPath(raw: string): string {
  return raw.trim().replace(/\/{2,}/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

const META = /[.*+?^${}()|[\]\\]/g;
const escape = (c: string): string => c.replace(META, "\\$&");

function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        const atSegmentStart = i === 0 || glob.charAt(i - 1) === "/";
        if (atSegmentStart && glob.charAt(i + 2) === "/") { out += "(?:.*/)?"; i += 2; continue; }
        if (atSegmentStart && i + 2 === glob.length) { out += ".*"; i += 1; continue; }
        out += "[^/]*"; i += 1; continue;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "\\" && i + 1 < glob.length) {
      out += escape(glob.charAt(i + 1)); i += 1;
    } else {
      out += escape(c);
    }
  }
  return out;
}

export function parsePatterns(text: string): ParsedPatterns {
  const rules: IgnoreRule[] = [];
  const invalid: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    let body = line;
    let negate = false;
    if (body.startsWith("!")) { negate = true; body = body.slice(1); }
    if (body.startsWith("\\#") || body.startsWith("\\!")) body = body.slice(1);
    body = body.replace(/\/+$/, "");
    const anchored = body.includes("/");
    body = body.replace(/^\/+/, "");
    if (body === "" || body === "**") { invalid.push(line); continue; }
    const src = globToRegexSource(body);
    // "docs/**" matches docs itself and everything below: the part after the last slash becomes optional.
    const withOptionalTail = src.endsWith("/.*") ? `${src.slice(0, -3)}(?:/.*)?` : src;
    rules.push({ source: line, negate, anchored, regex: new RegExp(`^${withOptionalTail}$`) });
  }
  return { rules, invalid };
}

/** Source of the last matching rule, or null. The root ("" or "/") never matches. */
export function matchIgnore(rules: readonly IgnoreRule[], folderPath: string): string | null {
  const path = normalizeFolderPath(folderPath);
  if (path === "") return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  let hit: string | null = null;
  for (const r of rules) {
    if (r.regex.test(r.anchored ? path : name)) hit = r.negate ? null : r.source;
  }
  return hit;
}

/** Like {@link matchIgnore}, but for a path whose FOLDERS may carry the rule: tries the path and every ancestor, outermost first,
 *  and returns the source of the first rule that hits one of them, or null. `matchIgnore` knows only the exact path, so a rule
 *  `Archiv/` would not reach `Archiv/sub/a.md`.
 *
 *  Origin: `isException` of the `filename-sanitizer` plugin (lifted 2026-11-09). A negation is resolved per prefix, as in
 *  `matchIgnore`: `!Archiv/keep` frees the folder `Archiv/keep` itself, but an earlier hit on `Archiv` stays a hit for
 *  `Archiv/keep/x.md`. The caller parses once (`parsePatterns`) and may cache the rules; this function holds no state. */
export function matchIgnoreChain(rules: readonly IgnoreRule[], path: string): string | null {
  if (rules.length === 0) return null;
  const parts = normalizeFolderPath(path).split("/");
  if (parts[0] === "") return null;
  for (let i = 1; i <= parts.length; i++) {
    const hit = matchIgnore(rules, parts.slice(0, i).join("/"));
    if (hit !== null) return hit;
  }
  return null;
}

/** Whether a path is ignored when every level of it is judged on its own and a negation on a deeper level can free what a shallower
 *  level hit: the path and each ancestor, outermost first; on one level the LAST matching rule wins (`!` frees, anything else hits);
 *  the deepest level with a hit decides. The answer for `Archiv/keep.md` under `Archiv/` + `!Archiv/keep.md` is false, where
 *  {@link matchIgnoreChain} keeps the hit on `Archiv` ("an earlier hit stays a hit"). Use this one when a negation is meant to carve an
 *  exception out of an ignored folder (a gitignore without the "cannot re-include a file if its parent directory is excluded" rule);
 *  use `matchIgnoreChain` when a hit on a folder must stay final (and when the source of the rule is wanted: this returns a boolean).
 *
 *  Origin: `isPathExcluded` of the `ghostline` plugin (`src/core/exclusion.ts`); the differential test in `tests/ignore-levels.test.ts`
 *  holds this function to a verbatim copy of it on 348 (pattern set, path) pairs. The path is normalized like in `matchIgnoreChain`;
 *  an empty path or no rules ignore nothing. The caller parses once and may cache the rules; this function holds no state. */
export function isIgnoredByLevels(rules: readonly IgnoreRule[], path: string): boolean {
  const segs = normalizeFolderPath(path).split("/").filter((s) => s !== "");
  let ignored = false;
  for (let i = 1; i <= segs.length; i++) {
    const levelPath = segs.slice(0, i).join("/");
    const name = segs[i - 1] ?? "";
    let hit: IgnoreRule | null = null;
    for (const r of rules) if (r.regex.test(r.anchored ? levelPath : name)) hit = r;
    if (hit) ignored = !hit.negate;
  }
  return ignored;
}

/** One rule line (`.gitignore` style, see the header) that hits exactly this path and nothing else: rooted with a leading `/`,
 *  `*`, `?` and `\` masked, a leading `#` or `!` masked. Round trip: `matchIgnore(parsePatterns(line).rules, path)` is not
 *  null, and it is null for every other path.
 *
 *  Returns **null** when no line can say it, because `parsePatterns` trims a line and `matchIgnore` normalizes the path first
 *  (`normalizeFolderPath`): a path with white space at either edge, doubled or edge slashes, a line break, or an empty path.
 *  A line written anyway would hit a different path than the one asked for, silently, so the caller gets null and decides.
 *
 *  Origin: `exceptionLine` of the `filename-sanitizer` plugin (lifted 2026-11-09), which returned a line for every path. */
export function exactIgnoreLine(path: string): string | null {
  if (path === "" || normalizeFolderPath(path) !== path || /[\r\n]/.test(path)) return null;
  const escaped = path.replace(/[\\*?]/g, "\\$&").replace(/^([#!])/, "\\$1");
  return `/${escaped}`;
}
