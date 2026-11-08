# Filename Sanitizer

> 🇬🇧 English · [🇩🇪 Deutsch](README.de.md)

**Repairs file names that Obsidian Sync or links reject, tells you briefly, keeps a log of every change and offers writing plugins a name API.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Docs: CC BY-SA 4.0](https://img.shields.io/badge/docs-CC%20BY--SA%204.0-lightgrey.svg)](LICENSE-DOCS)
![Platform](https://img.shields.io/badge/platform-Obsidian%201.11.4%2B%20%C2%B7%20desktop%20%26%20mobile-7c3aed)

LLMs, scripts and other tools create files whose names contain characters that Obsidian Sync on a phone refuses (`: ? * " < > | # ^ [ ]`), or that break links. Filename Sanitizer renames such files by fixed, adjustable rules, lets links follow, logs every change with everything that helps you find the writer, and stays out of your way. It never overwrites and never deletes a file.

## Features

- **Automatic repair after a quiet time** — a new file with an invalid name is checked only after it has not changed for 5 seconds (adjustable), so a writer that is still working keeps its file. Folders are repaired before their contents.
- **Rules you can change** — each invalid character has its own replacement (`vault-crews: Status` becomes `vault-crews — Status`, `12:30` becomes `12-30`, `ids[0]` becomes `ids(0)`). Leading and trailing spaces and dots, control characters and names that would end up empty are handled as well. A replacement that is itself invalid is refused and named.
- **Links go with the file** — the plugin renames with Obsidian's own file manager, so links to the file are updated. The old name is kept as an alias in the note (switchable).
- **Never a collision** — if the target name exists with identical content, the file stays and is marked as a duplicate; with different content a number is appended (`a — b 2.md`). A folder is never merged.
- **Review list** — choose per vault between *Automatic* and *Review first*. In *Review first*, and for everything the plugin must not do on its own, a list with old and new name shows what would change; you tick, untick or say *Always keep*.
- **Existing names stay untouched** — at the first start on a device nothing is renamed. Names that already exist appear in the review list; only names that appear later are repaired automatically.
- **Log** — one `.jsonl` file per device and month in a folder of your vault, with origin, effect, environment and chosen front matter fields; the start of the note text is optional and off by default. The view shows it newest first, filterable by device, folder and event.
- **Plugin API for writers** — `app.plugins.plugins["filename-sanitizer"].api` offers `sanitizeName` and `checkName` (synchronous). Plugins that write files ask it first and fall back to the same default rules without it, through `safeFileName` in `obsidian-kit`.
- **One notice per batch** — a click opens the log. It can be switched off.

## Requirements

- **Obsidian 1.11.4+**, desktop and mobile. On phones and tablets the plugin does not rename by default (switch *This device repairs*), so two devices never race for the same file; settings, log and API work everywhere.
- **Automatic renaming needs the Obsidian setting *Files and links → Automatically update internal links* on.** Otherwise Obsidian opens a dialog for every file that has backlinks and all further renames wait behind it. With the setting off the plugin renames nothing on its own and fills the review list. It never changes that setting.
- The plugin makes no network requests.

## Install

Not released yet. Once it is, install it from the release assets: copy `main.js`, `manifest.json` and `styles.css` into the folder `filename-sanitizer` inside your vault's plugin folder and enable the plugin under **Settings → Community plugins**.

## Use

Open **Review and log** from the command palette (**Open review and log**) to see what waits for you and what happened. **Check file names now** scans the vault again. Settings are grouped as *Repair*, *Exceptions*, and three collapsed groups *Replacements*, *Log* and *Advanced*. Details: [docs](docs/README.md).

## Limits

- A name containing a backslash (`\`) is invisible to Obsidian (not in its index, no event); the plugin cannot repair it.
- Only extensions Obsidian knows are renamed automatically; other files go to the review list.
- Whether Obsidian Sync accepts every character of the default table on every device, the exact behaviour of a race between two desktops and whether Sync carries the log file are measured on a real account only; see [troubleshooting](docs/troubleshooting.md).

## License

Code: AGPL-3.0-or-later ([LICENSE](LICENSE)). Documentation: CC BY-SA 4.0 ([LICENSE-DOCS](LICENSE-DOCS)). Dual-license option: [LICENSING.md](LICENSING.md).
