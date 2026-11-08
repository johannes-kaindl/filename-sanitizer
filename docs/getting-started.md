# Getting started

## First start

Enable the plugin. On this device nothing is renamed at the first start: every name that already breaks the rules is listed in the review list with the reason *Existing name*. Open it with the command **Open review and log**. All entries are ticked; press **Rename ticked** once to repair them, or untick what you want to keep. **Always keep** adds the exact path to the exceptions.

From then on a file that appears with an invalid name is repaired by itself, after it has not changed for the quiet time (5 seconds by default). A notice names the old and the new name, or the number of files when there were several; a click opens the log.

## Modes

- **Automatic** (default): repairs after the quiet time.
- **Review first**: nothing is renamed on its own; everything waits in the review list.

Both modes use the review list for what the plugin must not do alone: existing names from before the first start or made invalid by a later change of the rules, names that keep coming back (three repairs of the same path in ten minutes), and all names while *Automatically update internal links* is off in Obsidian.

## This device repairs

The switch *This device repairs* (Settings → Filename Sanitizer → Repair) is stored on this device only. It is on for desktops and off for phones and tablets. If you use several desktops on one vault, leave it on for the one you work on and off for the others to avoid two devices renaming the same file; the plugin also checks the file again right before renaming, which settles most races by itself.

## The rules

Invalid by default: `\ / : * ? " < > |` and the link breakers `# ^ [ ]`. Each has a replacement under *Replacements* (empty removes the character). Always applied: control characters are removed, spaces and dots at the edges of the name are removed, double spaces created by a replacement are collapsed, an empty result becomes `Untitled`. The extension of a file is never touched. Folders are treated like files, but their whole name counts.

| Character | Default replacement |
|---|---|
| `: ` (colon and space) | ` — ` |
| `:` | `-` |
| `?` `<` `>` | removed |
| `*` | `_` |
| `"` | `'` |
| `\` `/` `\|` | `-` |
| `#` `^` | space |
| `[` `]` | `(` `)` |

A replacement must not contain an invalid character. The settings refuse it and name the characters. *Advanced* adds more characters to replace and a maximum name length in bytes (0 is off; otherwise 32 to 255).

## Exceptions

*Exceptions* takes one pattern per line, written like a `.gitignore`: a name without a slash matches at any depth, a path with a slash is anchored at the vault root, `*` stays inside a name, `**` crosses folders. A pattern for a folder covers everything inside it. A matching name is never renamed, not even at the first start.

## The log

One file per device and month, for example `M5-2026-11.jsonl`, in the log folder (default `Filename Sanitizer/Log`). Every line is a JSON object with schema version 1. The log folder lies inside the vault, so Sync carries it unless you exclude it. Old months are deleted after the retention time (12 months by default; 0 keeps everything). The view shows the log newest first with filters for device, folder and event.

## For plugin authors

```ts
import { safeFileName } from "./vendor/kit-obsidian/safe-file-name"; // obsidian-kit, vendored
const { name } = safeFileName(app, "Plan: Q1?.md", { caller: "my-plugin" }); // "Plan — Q1.md"
```

`safeFileName` asks the plugin's API when it is installed and otherwise applies the default rules, so your plugin works without Filename Sanitizer. The API itself is `app.plugins.plugins["filename-sanitizer"].api` with `sanitizeName(name, { caller, kind? })` and `checkName(name, { kind? })`; both are synchronous, take a single path segment and return an error value (`{ error, message }`) instead of throwing. Collisions are the writer's job: use `numberedName` from `filename-policy`.
