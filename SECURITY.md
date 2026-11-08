# Security Policy

## Supported Versions

Security updates are provided for the most recently released version of Filename Sanitizer. Older versions do not receive backported fixes; please update to the latest release.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public issues. Report them privately by email to **code@jkaindl.de** (PGP-encrypted mail is welcome). You will receive a prompt acknowledgement and updates as the fix progresses.

## Data Handling / Scope

Filename Sanitizer is a fully local plugin:

- **No network access.** The plugin makes no outbound requests.
- **No telemetry, no analytics, no remote logging.**
- **Reads file names and folder names** of the vault through the Obsidian API. It reads file contents only to compare two files whose names collide, and front matter fields (and, if you turn the option on, the first characters of the text) only when it writes a log line.
- **Writes** its settings (`data.json`), a log folder inside the vault (one `.jsonl` file per device and month) and, after a successful rename, an alias in the renamed note. It renames files and folders with `fileManager.renameFile` so links follow; it never overwrites or deletes anything.

If you have questions about the plugin's data handling beyond what is described here, the same private contact applies.
