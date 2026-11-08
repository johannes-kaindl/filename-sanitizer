import { defineStrings } from "../vendor/kit/i18n";

/** Alle Nutzertexte (UI-STANDARD §10). EN ist kanonisch, DE vollständig; Schlüsselmengen prüft tests/strings.test.ts. */
export const STRINGS = {
  en: {
    "plugin.name": "Filename Sanitizer",
  },
  de: {
    "plugin.name": "Filename Sanitizer",
  },
} as const;

defineStrings(STRINGS);
