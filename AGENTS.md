# AGENTS.md

Orientierung für KI-Agenten (Claude Code, Codex, …) und Mitwirkende an diesem Repository. Workspace-weite Standards (comply-or-explain): siehe [`../../workspace/_docs/CONVENTIONS.md`](../../workspace/_docs/CONVENTIONS.md) (maintainer-lokal, nicht Teil dieses Repos — ignorieren, falls im Klon nicht vorhanden).

**Profil:** `ts-node` · `obsidian-plugin`.

**Stand 2026-11-09: gebaut und release-reif bis auf GitHub-Repo (0.1.0, nicht released, nicht getaggt).** Plan-Tasks 3 bis 12 umgesetzt, Gate grün, GUI-Smoke 13 von 13 auf Obsidian 1.15.0 (`docs/SMOKE.md`), Docs-Lint und README-Bilder (`scripts/shots.ts`) ohne Befund, Release-Infrastruktur vendort. Offen für den Erst-Release: GitHub-Repo (legt der Master privat an), Sync-Messungen S1 bis S4 und S6 mit Johannes (Cockpit-Task), Release und Store durch den Master. Spec und Plan liegen im Coding-Cockpit (`25_Coding/filename-sanitizer/_SDD/`, CORE-META-14).

## Project character

**Projekt:** `filename-sanitizer` — Obsidian-Plugin, das Dateinamen mit Zeichen, die Sync oder Links ablehnen (`: ? * " < > | \ / # ^ [ ]`), nach einstellbaren Regeln repariert, jede Änderung protokolliert und schreibenden Plugins eine API (`sanitizeName`, `checkName`) anbietet. Es benennt nur mit `app.fileManager.renameFile` um und überschreibt und löscht nie. Autor: Johannes Kaindl.

**Kit-first-Befund:** Die Regeln liegen als reine Funktionen in `code-kit` (`filename-policy`), der API-Vertrag und der Schreiber-Baustein `safeFileName` in `obsidian-kit` (`filename-sanitizer-source`, `safe-file-name`). Aus code-kit 0.63.0 kommen außerdem `matchIgnoreChain`, `exactIgnoreLine` („Immer so lassen“, bei `null` legt der Knopf nichts an und meldet es), `createRepeatGuard` (3 Reparaturen je Quellpfad in 10 Minuten) und `affixDiffSegments`. Das Plugin besitzt Einstellungen, Reparatur, Prüfliste, Protokoll und die API.

## Architecture principles

**PROF-OBS-03/04 — reiner Kern ohne `obsidian`-Import.** `src/core/` ist obsidian-frei und in Node ohne DOM testbar; nur `main.ts` und `src/obsidian/` importieren `obsidian`. `npm run check:pure` nagelt das fest.

**Vendoring statt Dependency.** Geteilte Bausteine liegen als Snapshot unter `src/vendor/kit/` (pure) und `src/vendor/kit-obsidian/`, je mit Herkunfts-Header und `VENDOR.json`. Nie von Hand editieren — Re-Vendoring über `sh tools/sync-kit.sh` (Pins in `tools/kit-sync.json`).

```
src/core/constants.ts       feste Grenzen (Ruhezeit, Wiederholungsschutz, Frist)
src/core/settings.ts        SanitizerSettings, loadSettings (Feldreparatur), trySetPolicy
src/core/queue.ts           createQuietQueue (Ruhezeit je Pfad, injizierte Timer)
src/core/decide.ts          decide (none | exception | rename | identical | review; Ausnahmen über Kit-`matchIgnoreChain` mit Regel-Cache), orderForRepair, initialSnapshot
src/core/scan.ts            scanDecisions (alle Funde in Reparaturreihenfolge)
src/core/log-entry.ts       Protokollzeilen (Schema 1), logFileName, expiredLogFiles, summarizeBurst
src/core/api.ts             createApi (Plugin-API v1, synchron, Fehler als Werte)
src/core/review-view.ts     ViewModel der Prüfliste (reviewItems, applyGate; Namensvergleich über Kit-`affixDiffSegments`)
src/core/log-view.ts        ViewModel des Protokolls (logRows, logFilterOptions)
src/obsidian/engine.ts      RepairEngine: Ereignisse, Ruhezeit, Neuprüfung, eine Umbenennung zur Zeit mit Frist, Alias, Protokoll
src/obsidian/device.ts      geräteeigene Werte im lokalen Speicher (repairs, name, snapshot)
src/obsidian/log-store.ts   .jsonl je Gerät und Monat im Vault
src/obsidian/view.ts        eine Ansicht mit Tabs Prüfen und Protokoll (Kit-Hub)
src/obsidian/settings-tab.ts  deklarativer Tab, Hilfe-Zeile zuerst, drei eingeklappte Gruppen
src/main.ts                 onload: Einstellungen, Gerät, Protokoll, API, Motor, Ansicht, Befehle
scripts/gui-smoke.ts        CDP-Treiber (Zweitinstanz), docs/SMOKE.md
scripts/shots.ts            Aufnahme der README-Bilder (Zweitinstanz), Vertrag docs/images/README.md
fixtures/vault/             Fixture für den GUI-Smoke
```

## Commands

- `npm run gate` — lint + typecheck + typecheck:test + typecheck:scripts + test + check:pure + build; Pflicht vor jedem Commit.
- `npm run smoke:gui -- --setup` baut den Staging-Vault, `npm run smoke:gui -- --port <Port> [--shots <Ordner>]` fährt den Smoke gegen die Zweitinstanz (Rezept im Dateikopf von `scripts/gui-smoke.ts`).
- `npm run shots -- --setup` und `npm run shots -- --port <Port>` nehmen die README-Bilder in `docs/images/` auf (Zweitinstanz, Rezept im Dateikopf von `scripts/shots.ts`, Vertrag `docs/images/README.md`); `npm run shots:check` prüft den Bild-Standard.
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

- **Bei `alwaysUpdateLinks` aus öffnet `renameFile` je Datei einen Dialog „Update links“, und alle weiteren Aufrufe warten dahinter** (gemessen 2026-11-08, Obsidian 1.15.1). Darum läuft die Automatik nur bei `app.vault.getConfig("alwaysUpdateLinks") === true`, für jede Endung (S5: die Endung ändert am Dialog nichts; gemessen nur an 1.15.1, `minAppVersion` 1.15.0 ungemessen; öffentlich ist 1.15.0, 1.15.1 nur Beta, Entscheidung Johannes 2026-11-09), strikt nacheinander und mit Frist von 10000 ms; nach einer abgelaufenen Frist hält sie bis zum nächsten Start an.
- **Eine Regeländerung macht Bestand zu Altbestand:** `RepairEngine.policyChanged()` (aus `saveSettings`) und der Start nehmen neu ungültige Namen in den Schnappschuss auf, sobald sich `JSON.stringify(settings.policy)` vom gespeicherten Stand unterscheidet; die Automatik fasst nur neue oder umbenannte Dateien an (Entscheidung 2026-11-08).
- **Ein Name mit `\` ist für Obsidian unsichtbar** (nicht im Index, kein Ereignis); das Plugin kann ihn nicht reparieren.
- **Geräteeigene Werte** (Schalter „Dieses Gerät repariert“, Gerätename, Schnappschuss des Altbestands, Stand der Richtlinie) liegen nur in `app.loadLocalStorage`/`saveLocalStorage`, nie in `data.json`, weil diese mitsynchronisiert wird.
- **Typname im Kit:** `FilenameHit` (nicht `Hit`); der API-Fehlertyp im Kit-Barrel heißt `FilenameSanitizerApiError`; `maxBytes` ist gültig bei 0 oder 32 bis 255; ein leerer Name aus dem Plugin löst den Rückfall in `safeFileName` aus.

- **Ein Desktop-Fenster mit 390 px ist kein Handy.** Die Seitenleisten behalten ihre Breite und lassen der Ansicht 22 px (Smoke-Messung 1, 2026-11-08); der Treiber klappt sie vor der 390-px-Messung ein.
- **Ein Popup-Schub endet erst 2 Sekunden nach der letzten Reparatur** (`BURST_MS` in `engine.ts`): ein Test, der Popups zählt, wartet die vorige Reparatur ab, sonst zählt sie mit.
- **Der Mock aus dem Kit kennt `Notice.messageEl` und `Setting.infoEl` nicht** (nur `noticeEl`, `descEl`); die Tests setzen `messageEl` selbst, der Code nutzt `descEl`.

## Memory

- 2026-11-08: Bau-Session (Sonnet) setzt Tasks 3 bis 12 um; Deckel 80 Mio. Einheiten.

## Abweichungen von der Leitkonvention

Keine bekannt.
