/** Feste Grenzen des Plugins (Plan, Global Constraints). */
export const DEFAULT_QUIET_MS = 5000;
export const REPEAT_LIMIT = 3;
export const REPEAT_WINDOW_MS = 600000;
export const RENAME_DEADLINE_MS = 10000;

/** Endungen, die Obsidian kennt: nur hier läuft die Automatik, der Rest geht in die Prüfliste (Spec § 6). */
export const LINK_SAFE_EXTENSIONS: readonly string[] = [
  "md", "canvas", "base", "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "pdf",
  "mp3", "wav", "m4a", "ogg", "3gp", "flac", "mp4", "webm", "ogv", "mov", "mkv",
];

export function isLinkSafeExtension(ext: string): boolean {
  return LINK_SAFE_EXTENSIONS.includes(ext.toLowerCase());
}
