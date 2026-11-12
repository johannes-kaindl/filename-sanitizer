# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

## [0.1.1] — 2026-11-12

### Added

- The log now records *Confirmed* when you rename from the review list and *Skipped* for entries you left unticked, writes *Collision* whenever a taken name forced a number, and fills in how many links pointed at a renamed file or folder.

### Changed

- The log folder and the number fields are checked when you leave the field: an invalid folder name (for example `a:b`, an empty or hidden segment) and values such as a quiet time of 0 are refused with a message instead of being saved or silently replaced.
- The review list keeps its scroll position and keyboard focus when you tick, untick or reject an entry, and the settings groups you opened stay open after a reset and when you reopen the settings.

### Fixed

- Switching *This device repairs* off on a desktop now sticks; before, Obsidian's local storage dropped the stored "off" and the switch came back on.
- A rename whose *Update links* dialog was confirmed only after the 10-second limit is now written to the log, and its target path is released again instead of staying reserved until restart.

## [0.1.0] — 2026-11-09

### Added

- Automatic repair of file names that Obsidian Sync or links reject, after a quiet time, folders before their contents, one rename at a time, links following through Obsidian's file manager.
- Collision rules: identical content leaves the file as a marked duplicate, different content gets a number, nothing is overwritten or deleted.
- Every extension is repaired automatically while *Automatically update internal links* is on; there is no list of known extensions. A name that becomes invalid only through a change of the rules is treated as existing: it goes to the review list instead of being renamed.
- Review list with *Automatic* and *Review first* modes, per-entry *Always keep*, and protection of names that existed before the first start on a device.
- Protection against writers that re-create the same invalid path (three repairs in ten minutes, then the review list and a notice).
- Log as one `.jsonl` file per device and month, with origin, effect, environment and chosen front matter fields, and a log view with filters.
- Plugin API v1 (`sanitizeName`, `checkName`) for writing plugins, with the fallback `safeFileName` in `obsidian-kit`.
- Settings tab with replacements per character, exceptions in `.gitignore` style, log options and advanced values; device values stay on the device.
- English and German texts, documentation in both languages, README with screenshots of the review list, the log and the settings.
