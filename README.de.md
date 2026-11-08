# Filename Sanitizer

> [🇬🇧 English](README.md) · 🇩🇪 Deutsch

**Repariert Dateinamen, die Obsidian Sync oder Links ablehnen, sagt kurz Bescheid, protokolliert jede Änderung und bietet schreibenden Plugins eine Namens-API.**

[![Lizenz: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Doku: CC BY-SA 4.0](https://img.shields.io/badge/docs-CC%20BY--SA%204.0-lightgrey.svg)](LICENSE-DOCS)
![Plattform](https://img.shields.io/badge/platform-Obsidian%201.11.4%2B%20%C2%B7%20desktop%20%26%20mobile-7c3aed)

LLMs, Skripte und andere Werkzeuge legen Dateien an, deren Namen Zeichen enthalten, die Obsidian Sync am Handy ablehnt (`: ? * " < > | # ^ [ ]`) oder die Links brechen. Filename Sanitizer benennt solche Dateien nach festen, einstellbaren Regeln um, lässt die Links mitgehen, protokolliert jede Änderung mit allem, was beim Finden des Schreibers hilft, und bleibt dir aus dem Weg. Er überschreibt nie und löscht nie eine Datei.

## Funktionen

- **Automatische Reparatur nach einer Ruhezeit** — eine neue Datei mit ungültigem Namen wird erst geprüft, wenn sie 5 Sekunden (einstellbar) unverändert blieb, damit ein Schreiber, der noch arbeitet, seine Datei behält. Ordner kommen vor ihrem Inhalt dran.
- **Regeln, die du ändern kannst** — jedes ungültige Zeichen hat eine eigene Ersetzung (`vault-crews: Status` wird `vault-crews — Status`, `12:30` wird `12-30`, `ids[0]` wird `ids(0)`). Auch Leerzeichen und Punkte am Rand, Steuerzeichen und Namen, die leer würden, werden behandelt. Eine Ersetzung, die selbst ungültig ist, wird abgelehnt und benannt.
- **Links gehen mit** — das Plugin benennt mit Obsidians eigenem Dateimanager um, daher werden Links auf die Datei angepasst. Der alte Name bleibt als Alias in der Notiz (abschaltbar).
- **Nie eine Kollision** — existiert der Zielname mit gleichem Inhalt, bleibt die Datei liegen und wird als Dublette markiert; bei anderem Inhalt wird eine Nummer angehängt (`a — b 2.md`). Ein Ordner wird nie zusammengeführt.
- **Prüfliste** — je Vault wählst du zwischen *Automatisch* und *Erst bestätigen*. In *Erst bestätigen* und für alles, was das Plugin nicht von selbst tun darf, zeigt eine Liste mit altem und neuem Namen, was sich ändern würde; du hakst an, ab oder sagst *Immer so lassen*.
- **Vorhandene Namen bleiben unberührt** — beim ersten Start auf einem Gerät wird nichts umbenannt. Bestehende Namen erscheinen in der Prüfliste; nur Namen, die später entstehen, werden automatisch repariert. Das gilt auch, wenn erst eine Regeländerung einen vorhandenen Namen ungültig macht: er kommt in die Prüfliste.
- **Protokoll** — eine `.jsonl`-Datei je Gerät und Monat in einem Ordner deines Vaults, mit Herkunft, Wirkung, Umgebung und gewählten Frontmatter-Feldern; der Anfang des Notiztextes ist optional und vorab aus. Die Ansicht zeigt es neueste zuerst, filterbar nach Gerät, Ordner und Ereignis.
- **Plugin-API für Schreiber** — `app.plugins.plugins["filename-sanitizer"].api` bietet `sanitizeName` und `checkName` (synchron). Plugins, die Dateien schreiben, fragen sie zuerst und fallen ohne sie auf dieselben Standardregeln zurück, über `safeFileName` in `obsidian-kit`.
- **Ein Popup je Schub** — ein Klick öffnet das Protokoll. Abschaltbar.

## Voraussetzungen

- **Obsidian 1.11.4+**, Desktop und Mobil. Auf Handy und Tablet benennt das Plugin vorab nicht um (Schalter *Dieses Gerät repariert*), damit zwei Geräte nicht um dieselbe Datei wetteifern; Einstellungen, Protokoll und API laufen überall.
- **Das automatische Umbenennen braucht die Obsidian-Einstellung *Dateien und Links → Interne Links automatisch aktualisieren* eingeschaltet.** Sonst öffnet Obsidian für jede Datei mit Backlinks einen Dialog, und alle weiteren Umbenennungen warten dahinter. Ist die Einstellung aus, benennt das Plugin nicht von selbst um und füllt die Prüfliste. Es ändert diese Einstellung nie.
- Das Plugin stellt keine Netzwerkanfragen.

## Installation

Noch nicht veröffentlicht. Danach installierst du es aus den Release-Dateien: Kopiere `main.js`, `manifest.json` und `styles.css` in den Ordner `filename-sanitizer` im Plugin-Ordner deines Vaults und schalte das Plugin unter **Einstellungen → Community-Plugins** ein.

## Benutzung

Öffne **Prüfliste und Protokoll öffnen** über die Befehlspalette, um zu sehen, was auf dich wartet und was geschehen ist. **Dateinamen jetzt prüfen** durchsucht den Vault erneut. Die Einstellungen sind gegliedert in *Reparatur*, *Ausnahmen* und drei eingeklappte Gruppen *Ersetzungen*, *Protokoll* und *Erweitert*. Einzelheiten: [Doku](docs/README.md).

## Grenzen

- Ein Name mit Rückwärts-Schrägstrich (`\`) ist für Obsidian unsichtbar (nicht im Index, kein Ereignis); das Plugin kann ihn nicht reparieren.
- Dateien jeder Endung werden automatisch umbenannt, solange in Obsidian „Interne Links automatisch aktualisieren“ an ist.
- Ob Obsidian Sync jedes Zeichen der Standardtabelle auf jedem Gerät annimmt, wie genau ein Rennen zweier Desktops ausgeht und ob Sync die Protokolldatei mitnimmt, lässt sich nur an einem echten Konto messen; siehe [Fehlersuche](docs/troubleshooting.md).

## Lizenz

Code: AGPL-3.0-or-later ([LICENSE](LICENSE)). Dokumentation: CC BY-SA 4.0 ([LICENSE-DOCS](LICENSE-DOCS)). Dual-License-Option: [LICENSING.md](LICENSING.md).
