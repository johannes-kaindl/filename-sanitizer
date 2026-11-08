import { defineStrings } from "../vendor/kit/i18n";

/** Alle Nutzertexte (UI-STANDARD §10). EN ist kanonisch, DE vollständig; Schlüsselmengen prüft tests/strings.test.ts. */
export const STRINGS = {
  en: {
    "plugin.name": "Filename Sanitizer",
    "notice.repaired.one": "Renamed \"{0}\" to \"{1}\". Click to open the log.",
    "notice.repaired.many": "Renamed {0} files with invalid names. Click to open the log.",
    "notice.repeat": "\"{0}\" keeps coming back with an invalid name. It was repaired three times and now waits in the review list. Check the plugin or script that writes it.",
    "notice.stalled": "Automatic renaming paused: renaming \"{0}\" did not finish. An \"Update links\" dialog may be open. Restart Obsidian to continue.",
  },
  de: {
    "plugin.name": "Filename Sanitizer",
    "notice.repaired.one": "\"{0}\" in \"{1}\" umbenannt. Klick öffnet das Protokoll.",
    "notice.repaired.many": "{0} Dateien mit ungültigem Namen umbenannt. Klick öffnet das Protokoll.",
    "notice.repeat": "\"{0}\" kommt immer wieder mit ungültigem Namen. Es wurde dreimal repariert und wartet jetzt in der Prüfliste. Prüfe das Plugin oder Skript, das es schreibt.",
    "notice.stalled": "Automatisches Umbenennen pausiert: \"{0}\" wurde nicht fertig umbenannt. Vielleicht ist ein Dialog \"Update links\" offen. Starte Obsidian neu, um fortzufahren.",
  },
} as const;

defineStrings(STRINGS);
