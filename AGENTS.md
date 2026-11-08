# AGENTS.md

Orientierung für KI-Agenten (Claude Code, Codex, …) und Mitwirkende an diesem Repository. Workspace-weite Standards (comply-or-explain): siehe [`../../workspace/_docs/CONVENTIONS.md`](../../workspace/_docs/CONVENTIONS.md) (maintainer-lokal, nicht Teil dieses Repos — ignorieren, falls im Klon nicht vorhanden).

**Profil:** `ts-node` · `obsidian-plugin`.

**Stand 2026-11-08: im Bau (0.1.0, nicht released).** Spec und Plan liegen im Coding-Cockpit (`25_Coding/filename-sanitizer/_SDD/`, CORE-META-14). Task 3 (Gerüst) steht; Tasks 4 bis 12 folgen.

## Project character

**Projekt:** `filename-sanitizer` — Obsidian-Plugin, das Dateinamen mit Zeichen, die Sync oder Links ablehnen (`: ? * " < > | \ / # ^ [ ]`), nach einstellbaren Regeln repariert, jede Änderung protokolliert und schreibenden Plugins eine API (`sanitizeName`, `checkName`) anbietet. Es benennt nur mit `app.fileManager.renameFile` um und überschreibt und löscht nie. Autor: Johannes Kaindl.

**Kit-first-Befund:** Die Regeln liegen als reine Funktionen in `code-kit` (`filename-policy`), der API-Vertrag und der Schreiber-Baustein `safeFileName` in `obsidian-kit` (`filename-sanitizer-source`, `safe-file-name`). Das Plugin besitzt Einstellungen, Reparatur, Prüfliste, Protokoll und die API.

## Architecture principles

**PROF-OBS-03/04 — reiner Kern ohne `obsidian`-Import.** `src/core/` ist obsidian-frei und in Node ohne DOM testbar; nur `main.ts` und `src/obsidian/` importieren `obsidian`. `npm run check:pure` nagelt das fest.

**Vendoring statt Dependency.** Geteilte Bausteine liegen als Snapshot unter `src/vendor/kit/` (pure) und `src/vendor/kit-obsidian/`, je mit Herkunfts-Header und `VENDOR.json`. Nie von Hand editieren — Re-Vendoring über `sh tools/sync-kit.sh` (Pins in `tools/kit-sync.json`).

## Commands

- `npm run gate` — lint + typecheck + typecheck:test + typecheck:scripts + test + check:pure + build; Pflicht vor jedem Commit.
- `sh tools/sync-kit.sh [--check]` — Kit-Vendoring aus `../obsidian-kit` und `../../libs/code-kit`.
- `node ../tools/css_baseline/check.mjs styles.css` — CSS-Baseline (sobald es `styles.css` gibt).
- `python3 ../tools/bibliothek/gate.py --repo filename-sanitizer --liste` — Bibliothek-Gate, Ziel 0 open.

## Conventions

- `src/core` ist obsidian-frei (`npm run check:pure`).
- Texte ausschließlich in `src/i18n/strings.ts`, EN kanonisch, DE vollständig; `tests/strings.test.ts` prüft die Schlüsselmengen.
- CSS-Präfix `fsan-`, nur Theme-Variablen, kein `!important` (UI-STANDARD §3).
- Keine Lookbehind-RegExp, kein `require()`, kein Import aus `electron`/`fs`/Node-Builtins.
- Vendorte Dateien nie von Hand editieren; `eslint.overrides.mjs` klammert `src/vendor/**` aus.
- Markdown-Dateien: ein Absatz je Zeile (Johannes' Regel seit 2026-09-19).

## Gotchas

- **Bei `alwaysUpdateLinks` aus öffnet `renameFile` je Datei einen Dialog „Update links“, und alle weiteren Aufrufe warten dahinter** (gemessen 2026-11-08, Obsidian 1.15.1). Darum läuft die Automatik nur bei `app.vault.getConfig("alwaysUpdateLinks") === true`, nur für Endungen aus `LINK_SAFE_EXTENSIONS`, strikt nacheinander und mit Frist von 10000 ms; nach einer abgelaufenen Frist hält sie bis zum nächsten Start an.
- **Ein Name mit `\` ist für Obsidian unsichtbar** (nicht im Index, kein Ereignis); das Plugin kann ihn nicht reparieren.
- **Geräteeigene Werte** (Schalter „Dieses Gerät repariert“, Gerätename, Schnappschuss des Altbestands) liegen nur in `app.loadLocalStorage`/`saveLocalStorage`, nie in `data.json`, weil diese mitsynchronisiert wird.
- **Typname im Kit:** `FilenameHit` (nicht `Hit`); der API-Fehlertyp im Kit-Barrel heißt `FilenameSanitizerApiError`; `maxBytes` ist gültig bei 0 oder 32 bis 255; ein leerer Name aus dem Plugin löst den Rückfall in `safeFileName` aus.

## Memory

- 2026-11-08: Bau-Session (Sonnet) setzt Tasks 3 bis 12 um; Deckel 80 Mio. Einheiten.

## Abweichungen von der Leitkonvention

Keine bekannt.
