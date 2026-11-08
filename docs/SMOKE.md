# GUI smoke checklist (maintainer material)

Runs with `npm run smoke:gui -- --port <port>` against a second Obsidian instance with its own profile (recipe in the header of `scripts/gui-smoke.ts`). The fixture vault is `fixtures/vault/` and is rebuilt by `npm run smoke:gui -- --setup`. The driver itself is the foreign writer: it creates files with the file system, not through Obsidian's API. Quiet time is set to 1000 ms for the run.

## Check points

| # | What is measured | How |
|---|---|---|
| 0 | Plugin loaded, restricted mode of a fresh profile lifted | `app.plugins.plugins["filename-sanitizer"]` exists |
| A | First start: an existing name (`alt: bestand.md`) stays untouched and is listed with reason *legacy* | device values reset, plugin enabled, file and `engine.pending()` read |
| B | `c1: rest.md` created from outside stays for 300 ms, then becomes `c1 — rest.md`; the link in `Links.md` follows and the old name is an alias; the control file `kontrolle.md` stays; `c2: fremd.foo` (any extension) is repaired the same way | files read from disk |
| C | `Ausnahme/x: y.md` stays (exception), `Draussen/x: y.md` is repaired | exception pattern `Ausnahme/` |
| R | Rule change: `r~alt.md` is valid, then `~` becomes an extra character; the name stays and the review list names it with reason *legacy*; `r2~neu.md` created afterwards becomes `r2-neu.md` | settings saved through the plugin, files read from disk, `engine.pending()` |
| D | `alwaysUpdateLinks` off: no "Update links" dialog, the file stays, the review list names the reason; after switching it on, the list renames and the link in `Links2.md` follows | `app.vault.setConfig` |
| E | Three repairs in a row give one notice ("Renamed 3 files …") | notice text read after a quiet period |
| F | The log file holds the line of `c1: rest.md` (event, schema 1), every line parses, the control file has none | `.jsonl` read from disk |
| G | `api.sanitizeName` answers synchronously, `checkName` too, an empty caller gives `invalid-input` | called in the renderer |
| H | In *Review first*, unticking `h2: x.md` and pressing *Rename ticked* renames `h1: x.md` only; the card of `h2` says "Stays as it is" | clicks on the cards and the button |
| I | Settings: help row first, groups Repair, Exceptions, Replacements, Log, Advanced in that order, three collapsed | settings window read |
| S7 | Duration of the start scan with 17,000 valid and 245 invalid names (measurement, no limit) | `engine.scanNow()` timed three times; valid only when the index holds all files |
| J | The view at 390 px (sidebars collapsed): 245 cards, no horizontal overflow, right edge inside the window, smallest button at least 28 px | DOM measures, screenshot `--shots <folder>` read by the maintainer |

Every point carries its own control: B the valid control file, C the same name outside the exception, D the switch turned back on, F the control file in the log, H the ticked sibling.

## Counter-probe

A local mutation (not committed) makes `hasFinding` in `src/obsidian/engine.ts` always return `false`; the run must turn red at B, C, D, E, F, H and S7 (no finding, so no review list) and stay green at 0, A, G, I and J (the start scan does not use `hasFinding`).

## Runs

| Date | Obsidian | Result | Counter-probe | Notes |
|---|---|---|---|---|
| 2026-11-08 | 1.15.1 (second instance, fresh process, English interface, port 9392) | 12 green · 0 red · 0 skipped · 0 not measured, denominator 12 | local mutation, not committed (`hasFinding` always false): 5 green · 7 red (B, C, D, E, F, H, S7) as expected; reverted | Runs 1 to 3 on the way: run 1 found two driver errors (popup count included the repair of D; at 390 px the sidebars left the view 22 px, fixed in the driver by collapsing them); run 3 had an incomplete index (17,100 files) and S7 turned red, the wait is now up to 420 s. S7: scan 38/32/33 ms with 17,261 files and 246 list entries (346/346/360 ms before the start scan told listeners once). J: 246 cards at 390 px, no overflow, smallest button 30 px, card 122 px high, screenshot looked at: readable. |
