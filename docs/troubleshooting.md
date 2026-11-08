# Troubleshooting

## A file with an invalid name was not renamed

Open **Open review and log**. The reason is shown on its card:

- *Existing name*: it was there before the plugin's first start on this device, or it became invalid only when you changed the rules (replacements, extra characters). The plugin repairs only files that are new or renamed, so tick it and press **Rename ticked**.
- *Waiting for your OK*: the mode is *Review first*.
- *Link update is off*: Obsidian's setting *Files and links → Automatically update internal links* is off. Turn it on, then press **Rename ticked**. The plugin never changes that setting. With it off Obsidian asks a question for every renamed file that has backlinks and holds back the next rename until you answer; measured with Obsidian 1.15.1.
- *Keeps coming back*: the same path was repaired three times within ten minutes; the writer creates it again after each repair. Fix the writer (the log shows `caller` for API calls and the origin of the file); the plugin stops so no endless numbered copies appear.
- *Duplicate*: a file with the corrected name and identical content already exists. The plugin never deletes; remove the extra copy yourself.
- *Paused*: a rename did not finish within 10 seconds, probably because a dialog was open. The automatic run stays paused until you restart Obsidian.

If nothing is listed: the device switch *This device repairs* may be off (phones and tablets by default), the path may match an exception, or the name contains a backslash (below).

## Names with a backslash

Obsidian does not index a file whose name contains `\` and sends no event for it (measured on macOS). The plugin cannot see it. Rename it in your file manager.

## A race between two computers

When two desktops with the plugin on repair the same file, the one where the file appeared usually wins and the other finds nothing to do. If both rename at once, the second finds the target with identical content and leaves the file as a duplicate in the review list instead of making a numbered copy. Whether Sync still creates a copy in a real race is not measured yet; keep *This device repairs* on for one desktop if you see copies.

## Not measured yet

- Which characters Obsidian Sync on iPhone, iPad and Android refuses beyond the default table (emoji, trailing dot, very long names).
- Whether Obsidian Sync carries the `.jsonl` log files by default.
- Whether five seconds of quiet are enough for a long Claude Code session (Write followed by Edit); change *Quiet time* under *Advanced* if the plugin renames a file while it is still being written.
