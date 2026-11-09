# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (without a `v` prefix).

## [Unreleased]

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
