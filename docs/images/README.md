# Aufnahme-Vertrag — README-Bilder

Was jedes Bild zeigen **muss**, damit es seinen Platz in der README verdient. Der Vertrag steht vor der Aufnahme fest; ein Bild, das ihn nicht erfüllt, wird neu aufgenommen oder fällt mit Begründung heraus.

Erzeugt von `scripts/shots.ts` (`npm run shots`), geprüft von `npm run shots:check` gegen den workspace-weiten Bild-Standard.

## Bilder

| Datei | Klasse | referenziert von | muss zeigen |
|---|---|---|---|
| `hero.png` | hero (820) | README-Kopf, beide Sprachen | Das ganze Fenster: links der Datei-Explorer mit den schon reparierten Namen (`Release plan — v2.md`, `Standup — Monday.md`), rechts die Prüfliste mit den Namen, die schon vor dem Plugin da waren. Das Versprechen in einem Bild: Neues wird repariert, Vorhandenes wartet auf dein OK. |
| `review.png` | feature (820) | „How it works“ | Die Prüfliste allein mit den vier Altbestand-Namen: alter Name, neuer Name mit markierten Änderungen, Grund „Existing name“, Haken, Knopf „Rename 4 ticked“. |
| `log.png` | feature (820) | „How it works“ | Den Tab *Log* mit den Reparaturen, neueste zuerst, und den Filtern für Gerät, Ordner und Ereignis. |
| `settings.png` | detail (380, verlinkt auf Vollauflösung) | „Configuration“ | Den Einstellungs-Tab im Auslieferungszustand: Hilfe-Zeile zuerst, die Gruppen *Repair* und *Exceptions* offen, *Replacements*, *Log* und *Advanced* eingeklappt. |

## Fixture

`fixtures/vault/` ist der Vault des GUI-Smoke und zugleich Grundlage dieser Aufnahmen. Die Schau-Namen stehen als Konstanten in `scripts/shots.ts` (`ALTBESTAND`, `NEU`, `GUELTIG`) und werden zur Laufzeit geschrieben: so bleibt die Zählung des Smoke unberührt.

**Alle Inhalte sind generisch und englisch.** Keine echten Personen, Firmen oder Zahlen. `README.md` ist die kanonische Fassung, `README.de.md` bettet dieselben Bilder ein.

## Reproduktion

```bash
npm run build
npm run shots -- --setup        # Staging-Vault aus dem Fixture bauen
# Zweitinstanz mit eigenem Profil und Port starten (Rezept im Kopf von scripts/shots.ts)
npm run shots -- --port <Port>  # alle vier Bilder in einem Lauf
npm run shots:check             # Bild-Standard
```
