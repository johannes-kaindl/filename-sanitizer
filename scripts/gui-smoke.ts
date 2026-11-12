/**
 * GUI-Smoke — fährt die Prüfpunkte aus docs/SMOKE.md gegen ein LAUFENDES Obsidian (CORE-TEST-02 b).
 * Der Treiber ist selbst der „fremde Schreiber“: Dateien entstehen mit Node-`fs` im Vault, nicht über Obsidians API.
 *
 * ## Zweitinstanz (eigenes Profil, eigener Port — NICHT die reguläre Instanz anfassen; `--port` ist Pflicht)
 *
 * Ein Aufruf statt der Schritte unten: `tools/obsidian-cdp/messlauf.sh` im Dach (Rezept und Lock im Kopf der Datei; `SMOKE_ARGS="--shots <Ordner>"` für Bilder, `SMOKE_ARGS="--abschnitt s7"` für die lange Messung allein).
 * Die Schritte von Hand:
 *
 *   npm run build && npm run smoke:gui -- --setup
 *   UD=<Profilordner>; mkdir -p "$UD"; cp ~/Library/Application\ Support/obsidian/obsidian-*.asar "$UD"/
 *   node -e 'require("fs").writeFileSync(process.argv[1]+"/obsidian.json",JSON.stringify({vaults:{"fsan":{path:process.argv[2],ts:Date.now(),open:true}},language:"en"}))' "$UD" "$(node -e 'console.log(process.env.STAGING_VAULTS_DIR+"/filename-sanitizer")')"
 *   python3 ~/.claude/hooks/obsidian-cdp-lock.py acquire --label filename-sanitizer --intent "GUI-Smoke" --exclusive focus --port <Port> --ttl 900 --warten 300 && \
 *   { /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir="$UD" --remote-debugging-port=<Port> --lang=en & } && npm run smoke:gui -- --port <Port>
 *   python3 ~/.claude/hooks/obsidian-cdp-lock.py release --port <Port>; pkill -f "user-data-dir=$UD"
 *
 * Die Messung S7 (Startscan mit 17.000 Dateien) und die 390-px-Ansicht laufen am Ende im selben Lauf; Bilder landen in `--shots <Ordner>`.
 * Bilanz: `createBilanz` mit Soll-Liste. Exit 1 bei Rot oder „nichts gemessen“, Exit 2 bei Abbruch.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "node:process";

import { createBilanz, parseArgs, runDriver } from "../../tools/obsidian-cdp/bilanz.js";
import { Cdp, attachTo, beimAbbruch, bereiteInstanzVor, clearNotices, istAbgebrochen, notices, pollUntil, requireVisible, schliesseDialog, schliesseEinstellungen } from "../../tools/obsidian-cdp/cdp.js";
import { capture, setWindowSize, withMetrics } from "../../tools/obsidian-cdp/shot.js";
import { buildVault, requireEigenerBuild, stagingVaultDir } from "../../tools/obsidian-cdp/vault.js";

const REPO_NAME = "filename-sanitizer";
const PLUGIN_ID = "filename-sanitizer";
const REPO_ROOT = cwd();
const FIXTURE_DIR = join(REPO_ROOT, "fixtures/vault");
const QUIET_MS = 1000;
const BULK_VALID = 17000;
const BULK_BAD = 245;

const PUNKTE = [
  "0 Plugin geladen (Restricted-Mode-Guard)",
  "O Gerätewert: Der Schalter „Dieses Gerät repariert“ bleibt nach dem Ausschalten aus (Obsidians lokaler Speicher verwirft ein gespeichertes false)",
  "A Altbestand beim ersten Start unberührt und in der Prüfliste",
  "B Extern angelegtes „c1: rest.md“ wird nach der Ruhezeit „c1 — rest.md“, Link und Alias folgen, Kontrolldatei bleibt; eine Datei mit beliebiger Endung („c2: fremd.foo“) wird ebenso repariert",
  "C Ausnahme-Ordner bleibt, derselbe Name außerhalb wird repariert",
  "R Regeländerung macht einen Bestandsnamen ungültig: er bleibt liegen und steht in der Prüfliste, eine danach angelegte Datei wird repariert",
  "D alwaysUpdateLinks aus: kein Dialog, Datei bleibt, Prüfliste nennt den Grund; danach löst die Liste aus",
  "E Mehrere Reparaturen ergeben ein gebündeltes Popup",
  "F Das Protokoll (.jsonl) enthält die Zeile, die Kontrolldatei nicht",
  "G app.plugins.plugins[…].api antwortet (sanitizeName, checkName, Fehlerwert)",
  "L Eine Umbenennung, deren Dialog „Update links“ erst nach der Frist bestätigt wird, kommt ins Protokoll, der eigene Zielpfad wird frei, die Automatik bleibt angehalten",
  "H Haken weg lässt die Datei stehen, der angehakte Eintrag wird umbenannt; das Protokoll nennt bestätigt und übersprungen",
  "I Einstellungen: Hilfe-Zeile zuerst, Gruppen in der Reihenfolge der Spec",
  "K Einstellungen bei 390 px: kein seitliches Überlaufen, auch mit allen Gruppen aufgeklappt",
  "N Einstellungen: aufgeklappte Gruppen bleiben nach einem Zurücksetzen und nach dem Wiederöffnen offen",
  "S7 Startscan bei 17.000 Dateien (Dauer gemessen)",
  "J Ansicht bei 390 px: 245 Karten, kein seitliches Überlaufen, Knöpfe greifbar",
  "M Prüfliste mit 245 Karten: Scrollposition und Fokus bleiben nach Ablehnen einer Karte",
] as const;

// `--abschnitt s7`: nur Grundlage, Startscan und die 390-px-Ansicht (für Wiederholungen der langsamen Messung, ohne Einstellungen zu öffnen); die Teilmenge ist das Soll.
const NUR_S7 = parseArgs(process.argv.slice(2)).value("abschnitt") === "s7";
const SOLL = (NUR_S7 ? PUNKTE.filter((p) => /^(0|O|S7|J|M) /.test(p)) : PUNKTE) as unknown as typeof PUNKTE;
const bilanz = createBilanz({ punkte: SOLL });
const { record } = bilanz;
const q = (s: unknown): string => JSON.stringify(s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const P = `app.plugins.plugins[${q(PLUGIN_ID)}]`;

function setup(): void {
  const vaultDir = stagingVaultDir(REPO_NAME);
  const log = buildVault({ repoRoot: REPO_ROOT, vaultDir, fixtureDir: FIXTURE_DIR, pluginId: PLUGIN_ID });
  console.log(`Staging-Vault gebaut: ${vaultDir}`);
  for (const l of log) console.log(`  · ${l}`);
  console.log("\nZweitinstanz starten (Rezept im Dateikopf), dann:\n  npm run smoke:gui -- --port <Port>");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("setup")) { setup(); return; }
  const portArg = args.value("port");
  if (!portArg || !Number.isInteger(Number(portArg))) throw new Error("--port <Port> ist Pflicht (Zweitinstanz) — kein Standardport.");
  const port = Number(portArg);
  const shots = args.value("shots");
  if (shots) mkdirSync(shots, { recursive: true });

  console.log(`GUI-Smoke filename-sanitizer — Obsidian auf Port ${port}`);
  const cdp = await attachTo("workspace", port, REPO_NAME);
  if (!cdp) throw new Error(`Kein Obsidian-Hauptfenster auf Port ${port} für Vault „${REPO_NAME}“.`);

  const warnungen: string[] = [];
  let vaultDir = "";
  const w = (rel: string, text = "x\n"): void => { const f = join(vaultDir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
  const has = (rel: string): boolean => existsSync(join(vaultDir, rel));
  const wait = async (fn: () => boolean, ms = 8000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(200); } return fn(); };
  const pending = (): Promise<{ path: string; reason: string }[]> => cdp.evaluate(`return ${P}.engine.pending().map((e) => ({ path: e.path, reason: e.reason }));`);
  const tweak = (patch: Record<string, unknown>): Promise<boolean> => cdp.evaluate(`Object.assign(${P}.settings, ${q(patch)}); await ${P}.saveSettings(); return true;`);

  const zustandZurueck = async (): Promise<void> => {
    try {
      await cdp.evaluate(`app.vault.setConfig("alwaysUpdateLinks", true); return true;`);
      await schliesseEinstellungen(cdp);
      await setWindowSize(cdp, 1200, 800);
      await cdp.evaluate(`app.workspace.leftSplit.expand(); app.workspace.rightSplit.expand(); return true;`);
      if (vaultDir) for (const d of ["bulk", "bulkbad"]) rmSync(join(vaultDir, d), { recursive: true, force: true });
    } catch { console.log("  ! Aufräumen fehlgeschlagen — Staging-Vault mit --setup neu bauen"); }
  };
  const zustand = beimAbbruch(zustandZurueck, "Link-Einstellung, Fenstergröße und Massendateien zurücksetzen");
  try {
    await requireVisible(cdp);
    const klar = await bereiteInstanzVor(cdp, { pluginIds: [PLUGIN_ID], nurVault: REPO_NAME, sprache: "en" });
    console.log(`  (${klar.hinweis})`);
    const info = await cdp.evaluate<{ name: string; basePath: string; configDir: string }>(`return { name: app.vault.getName(), basePath: app.vault.adapter.basePath, configDir: app.vault.configDir };`);
    vaultDir = info.basePath;
    console.log(`Vault: ${info.name} (${vaultDir})\n`);
    requireEigenerBuild(join(vaultDir, info.configDir, "plugins", PLUGIN_ID, "main.js"), join(REPO_ROOT, "main.js"), (m) => warnungen.push(m));

    // Ausgangslage: Plugin aus, Gerätewerte weg (= erster Start), Altbestand und Einstellungen von außen.
    console.log("0 · Grundlage");
    await cdp.evaluate(`try { await app.plugins.disablePlugin(${q(PLUGIN_ID)}); } catch {} for (const k of ["repairs", "name", "snapshot", "policy"]) app.saveLocalStorage("filename-sanitizer-" + k, null); return true;`);
    for (const d of ["Filename Sanitizer", "bulk", "bulkbad"]) rmSync(join(vaultDir, d), { recursive: true, force: true });
    for (const f of readdirSync(vaultDir)) if (/^(c1|c2|d|e\d|h\d|Links2|kontrolle|alt|r~|r-|r2)/.test(f) && f !== "ok.md") rmSync(join(vaultDir, f), { force: true });
    rmSync(join(vaultDir, "Draussen"), { recursive: true, force: true });
    rmSync(join(vaultDir, "Ausnahme", "x: y.md"), { force: true });
    writeFileSync(join(vaultDir, info.configDir, "plugins", PLUGIN_ID, "data.json"), JSON.stringify({ quietMs: QUIET_MS, exceptions: "Ausnahme/", mode: "auto" }));
    w("Links.md", "# Links\n\nA link to a note that does not exist yet: [[c1: rest]]\n");
    w("alt: bestand.md", "legacy\n");
    await sleep(1500);
    await cdp.evaluate(`await app.plugins.enablePlugin(${q(PLUGIN_ID)}); return true;`);
    const geladen = (await cdp.evaluate<{ g: boolean }>(`return { g: Boolean(${P}) };`)).g;
    record("0 Plugin geladen (Restricted-Mode-Guard)", geladen, geladen ? `Vault ${info.name} (${klar.hinweis})` : `${PLUGIN_ID} fehlt — ${klar.hinweis}`);
    if (!geladen) throw new Error("Ohne geladenes Plugin ist jeder weitere Punkt gegenstandslos.");

    // --- O ---
    console.log("\nO · Gerätewert");
    const o = await cdp.evaluate<{ vorher: unknown; aus: unknown; roh: unknown; wieder: unknown }>(`
      const d = ${P}.device;
      const vorher = d.repairs;
      d.setRepairs(false);
      const aus = d.repairs;
      const roh = app.loadLocalStorage("filename-sanitizer-repairs");
      app.saveLocalStorage("filename-sanitizer-repairs", null);
      return { vorher, aus, roh, wieder: d.repairs };
    `);
    record("O Gerätewert: Der Schalter „Dieses Gerät repariert“ bleibt nach dem Ausschalten aus (Obsidians lokaler Speicher verwirft ein gespeichertes false)", o.vorher === true && o.aus === false && o.wieder === true,
      `Vorgabe=${q(o.vorher)}, nach setRepairs(false)=${q(o.aus)}, gespeicherter Rohwert=${q(o.roh)}, nach Zurücksetzen=${q(o.wieder)}`);

    abschnitt: {
    if (NUR_S7) break abschnitt;

    // --- A ---
    console.log("\nA · Altbestand");
    await pollUntil(cdp, `return ${P}.engine.pending().length > 0;`, 8000, 300);
    await sleep(QUIET_MS + 1500);
    const pa = await pending();
    record("A Altbestand beim ersten Start unberührt und in der Prüfliste", has("alt: bestand.md") && pa.some((e) => e.path === "alt: bestand.md" && e.reason === "legacy") && has("ok.md"), `liegt=${has("alt: bestand.md")}, Liste=${q(pa)}`);

    // --- B ---
    console.log("\nB · Reparatur nach der Ruhezeit");
    w("c1: rest.md", "# rest\n"); w("c2: fremd.foo", "foo\n"); w("kontrolle.md", "# fine\n");
    await sleep(300);
    const stillThere = has("c1: rest.md");
    const done = await wait(() => has("c1 — rest.md") && !has("c1: rest.md"), QUIET_MS + 8000);
    const fooDone = await wait(() => has("c2 — fremd.foo") && !has("c2: fremd.foo"), QUIET_MS + 8000);
    await sleep(1200);
    const links = readFileSync(join(vaultDir, "Links.md"), "utf8");
    const body = done ? readFileSync(join(vaultDir, "c1 — rest.md"), "utf8") : "";
    record("B Extern angelegtes „c1: rest.md“ wird nach der Ruhezeit „c1 — rest.md“, Link und Alias folgen, Kontrolldatei bleibt; eine Datei mit beliebiger Endung („c2: fremd.foo“) wird ebenso repariert",
      stillThere && done && fooDone && links.includes("[[c1 — rest]]") && /aliases:[\s\S]*c1: rest/.test(body) && has("kontrolle.md"),
      `nach 300 ms noch alt=${stillThere}, umbenannt=${done}, Link=${q(links.split("\n")[2])}, Alias=${/c1: rest/.test(body)}, Kontrolle=${has("kontrolle.md")}, .foo umbenannt=${fooDone}`);

    // --- C ---
    console.log("\nC · Ausnahme");
    w("Ausnahme/x: y.md"); w("Draussen/x: y.md");
    const outside = await wait(() => has("Draussen/x — y.md"), QUIET_MS + 8000);
    await sleep(1000);
    record("C Ausnahme-Ordner bleibt, derselbe Name außerhalb wird repariert", outside && has("Ausnahme/x: y.md") && !has("Draussen/x: y.md"), `außen=${outside}, Ausnahme blieb=${has("Ausnahme/x: y.md")}`);

    // --- R ---
    console.log("\nR · Regeländerung");
    w("r~alt.md", "bestand\n");
    await sleep(QUIET_MS + 1500);
    await cdp.evaluate(`${P}.settings.policy = Object.assign({}, ${P}.settings.policy, { extraChars: "~", extraReplacement: "-" }); await ${P}.saveSettings(); return true;`);
    await sleep(QUIET_MS + 2500);
    const pr = await pending();
    const bleibt = has("r~alt.md") && !has("r-alt.md");
    w("r2~neu.md", "neu\n");
    const neuDone = await wait(() => has("r2-neu.md") && !has("r2~neu.md"), QUIET_MS + 8000);
    record("R Regeländerung macht einen Bestandsnamen ungültig: er bleibt liegen und steht in der Prüfliste, eine danach angelegte Datei wird repariert",
      bleibt && pr.some((e) => e.path === "r~alt.md" && e.reason === "legacy") && neuDone,
      `Bestand blieb=${bleibt}, Liste=${q(pr)}, neue Datei repariert=${neuDone}`);
    await cdp.evaluate(`${P}.settings.policy = Object.assign({}, ${P}.settings.policy, { extraChars: "", extraReplacement: "" }); await ${P}.saveSettings(); return true;`);
    rmSync(join(vaultDir, "r~alt.md"), { force: true });

    // --- D ---
    console.log("\nD · Link-Einstellung aus");
    await cdp.evaluate(`app.vault.setConfig("alwaysUpdateLinks", false); return true;`);
    w("d: link.md", "# d\n"); w("Links2.md", "[[d: link]]\n");
    await sleep(QUIET_MS + 2500);
    const dialog = await cdp.evaluate<boolean>(`return Array.from(document.querySelectorAll(".modal")).some((m) => /Update links/i.test(m.textContent || ""));`);
    const pd = await pending();
    const stayed = has("d: link.md");
    const reasonOk = pd.some((e) => e.path === "d: link.md" && e.reason === "link-setting");
    await cdp.evaluate(`app.vault.setConfig("alwaysUpdateLinks", true); return true;`);
    await cdp.evaluate(`await ${P}.engine.applyReview(["d: link.md"]); return true;`);
    const unlocked = await wait(() => has("d — link.md"), 6000);
    await sleep(800);
    record("D alwaysUpdateLinks aus: kein Dialog, Datei bleibt, Prüfliste nennt den Grund; danach löst die Liste aus", !dialog && stayed && reasonOk && unlocked && readFileSync(join(vaultDir, "Links2.md"), "utf8").includes("[[d — link]]"),
      `Dialog=${dialog}, blieb liegen=${stayed}, Grund=${reasonOk}, nach Einschalten umbenannt=${unlocked}, Link2=${q(readFileSync(join(vaultDir, "Links2.md"), "utf8").trim())}`);

    // --- E ---
    console.log("\nE · Gebündeltes Popup");
    await sleep(3500); // das Popup der Reparatur aus D soll vorbei sein, sonst zählt es zum Schub
    await clearNotices(cdp);
    w("e1: a.md"); w("e2: b.md"); w("e3: c.md");
    await wait(() => has("e3 — c.md"), QUIET_MS + 8000);
    await sleep(3000);
    const n = await notices(cdp);
    const repaired = n.split(" | ").filter((t) => /^Renamed .*(file|\")/i.test(t));
    record("E Mehrere Reparaturen ergeben ein gebündeltes Popup", repaired.length === 1 && /Renamed 3 files/.test(repaired[0]), `Popups=${q(repaired)}`);

    // --- F ---
    console.log("\nF · Protokoll");
    const logDir = join(vaultDir, "Filename Sanitizer", "Log");
    const lines = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(logDir, f), "utf8").split("\n").filter(Boolean)) : [];
    const parsed = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } });
    const rest = parsed.find((l) => l?.oldPath === "c1: rest.md");
    record("F Das Protokoll (.jsonl) enthält die Zeile, die Kontrolldatei nicht", Boolean(rest) && rest?.event === "repariert" && rest?.v === 1 && !parsed.some((l) => l === null) && !parsed.some((l) => l?.oldPath === "kontrolle.md") && parsed.some((l) => l?.event === "bestätigt" && l?.oldPath === "d: link.md" && l?.trigger === "list"),
      `Zeilen=${lines.length}, bestätigt(d)=${parsed.some((l) => l?.event === "bestätigt" && l?.oldPath === "d: link.md")}, Zeile c1=${q(rest ? { event: rest.event, newPath: rest.newPath, trigger: rest.trigger } : null)}`);

    // --- G ---
    console.log("\nG · API");
    const g = await cdp.evaluate<{ s: unknown; c: unknown; bad: unknown; sync: boolean }>(`const a = ${P}.api; const r = a.sanitizeName("a: b.md", { caller: "smoke" }); return { s: r, c: a.checkName("ok.md"), bad: a.sanitizeName("a: b.md", { caller: "" }), sync: !(r instanceof Promise) };`);
    const gs = g.s as { name?: string; changed?: boolean };
    record("G app.plugins.plugins[…].api antwortet (sanitizeName, checkName, Fehlerwert)", gs.name === "a — b.md" && gs.changed === true && (g.c as { valid?: boolean }).valid === true && (g.bad as { error?: string }).error === "invalid-input" && g.sync, `sanitize=${q(gs)}, check=${q(g.c)}, leerer caller=${q(g.bad)}`);

    // --- L ---
    // Der Dialog „Update links“ entsteht echt: die Link-Einstellung ist aus, nur die Entscheidung der Automatik wird auf „an“ gestellt (Instanzfeld über die Klasse), Obsidians renameFile liest die echte Einstellung.
    console.log("\nL · Späte Bestätigung nach der Frist");
    await cdp.evaluate(`app.vault.setConfig("alwaysUpdateLinks", false); ${P}.engine.linkAuto = () => true; return true;`);
    w("Links3.md", "[[l1: spaet]]\n"); await sleep(1500);
    w("l1: spaet.md", "# spaet\n");
    const dialogOffen = await pollUntil<boolean>(cdp, `return Array.from(document.querySelectorAll(".modal")).some((m) => /Update links/i.test(m.textContent || "")) ? true : null;`, QUIET_MS + 8000, 200);
    const angehalten = await pollUntil<boolean>(cdp, `return ${P}.engine.halted === true ? true : null;`, 16000, 300);
    const ownVor = await cdp.evaluate<string[]>(`return Array.from(${P}.engine.ownTargets);`);
    // Die Datei trägt den neuen Namen schon, renameFile wartet auf die Antwort im Dialog (Messung S5, fertigInMs=null): erst die Antwort beendet es.
    const antwort = await cdp.evaluate<{ texte: string[]; geklickt: string | null }>(`
      const m = Array.from(document.querySelectorAll(".modal")).find((x) => /Update links/i.test(x.textContent || ""));
      if (!m) return { texte: [], geklickt: null };
      const bs = Array.from(m.querySelectorAll("button"));
      const wahl = bs.find((b) => /^update links?$/i.test((b.textContent || "").trim())) || bs.find((b) => b.classList.contains("mod-cta"));
      const texte = bs.map((b) => (b.textContent || "").trim());
      if (wahl) wahl.click();
      return { texte, geklickt: wahl ? (wahl.textContent || "").trim() : null };
    `);
    let frei = await pollUntil<boolean>(cdp, `return ${P}.engine.ownTargets.size === 0 ? true : null;`, 8000, 250);
    let geschlossenMit = antwort.geklickt === null ? "kein Knopf gefunden" : `Knopf ${q(antwort.geklickt)}`;
    if (frei === null) { await schliesseDialog(cdp); geschlossenMit += ", danach Dialog geschlossen"; frei = await pollUntil<boolean>(cdp, `return ${P}.engine.ownTargets.size === 0 ? true : null;`, 8000, 250); }
    const spaetDa = await wait(() => has("l1 — spaet.md") && !has("l1: spaet.md"), 4000);
    await sleep(1000);
    const dialogNach = await cdp.evaluate<number>(`return Array.from(document.querySelectorAll(".modal")).filter((x) => /Update links/i.test(x.textContent || "")).length;`);
    const ownNach = await cdp.evaluate<string[]>(`return Array.from(${P}.engine.ownTargets);`);
    const lLog = await cdp.evaluate<{ event: string; oldPath: string; message?: string }[]>(`return (await ${P}.logStore.read(500)).filter((e) => e.oldPath === "l1: spaet.md").map((e) => ({ event: e.event, oldPath: e.oldPath, message: e.message }));`);
    const stillHalted = await cdp.evaluate<boolean>(`return ${P}.engine.halted === true;`);
    const linkBody = readFileSync(join(vaultDir, "Links3.md"), "utf8").trim();
    // Zustand zurück: Automatik wieder frei, Link-Einstellung an.
    await cdp.evaluate(`delete ${P}.engine.linkAuto; ${P}.engine.halted = false; app.vault.setConfig("alwaysUpdateLinks", true); return true;`);
    record("L Eine Umbenennung, deren Dialog „Update links“ erst nach der Frist bestätigt wird, kommt ins Protokoll, der eigene Zielpfad wird frei, die Automatik bleibt angehalten",
      dialogOffen === true && angehalten === true && ownVor.includes("l1 — spaet.md") && spaetDa && frei === true && dialogNach === 0 && ownNach.length === 0 && stillHalted
        && lLog.some((e) => e.event === "fehlgeschlagen") && lLog.some((e) => e.event === "repariert" && /after the 10000 ms deadline/.test(e.message ?? "")),
      `Dialog=${dialogOffen}, Knöpfe=${q(antwort.texte)}, beantwortet mit ${geschlossenMit}, angehalten nach Frist=${angehalten}, ownTargets vor Bestätigung=${q(ownVor)}, nach=${q(ownNach)} (frei=${frei}), Dialog danach offen=${dialogNach}, umbenannt=${spaetDa}, Link=${q(linkBody)}, Protokoll=${q(lLog)}`);

    // --- H ---
    console.log("\nH · Haken weg");
    await tweak({ mode: "review" });
    w("h1: x.md"); w("h2: x.md");
    await pollUntil(cdp, `return ${P}.engine.pending().filter((e) => /^h\\d: x/.test(e.path)).length === 2;`, QUIET_MS + 8000, 300);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-review-and-log`)}); return true;`);
    await pollUntil(cdp, `return document.querySelector('.okit-review-card[data-id="h2: x.md"]') ? true : null;`, 6000, 200);
    await cdp.evaluate(`const b = document.querySelector('.okit-review-card[data-id="h2: x.md"] .okit-review-reject'); if (b) b.click(); return Boolean(b);`);
    await sleep(500);
    await cdp.evaluate(`const b = document.querySelector(".fsan-apply button"); if (b) b.click(); return Boolean(b);`);
    const h1 = await wait(() => has("h1 — x.md"), 8000);
    await sleep(800);
    const stays = await cdp.evaluate<string>(`const c = document.querySelector('.okit-review-card[data-id="h2: x.md"]'); return c ? c.textContent : "";`);
    const hLog = await cdp.evaluate<{ event: string; oldPath: string }[]>(`return (await ${P}.logStore.read(500)).filter((e) => /^h\\d: x/.test(e.oldPath)).map((e) => ({ event: e.event, oldPath: e.oldPath }));`);
    const hHat = (event: string, oldPath: string): boolean => hLog.some((e) => e.event === event && e.oldPath === oldPath);
    record("H Haken weg lässt die Datei stehen, der angehakte Eintrag wird umbenannt; das Protokoll nennt bestätigt und übersprungen", h1 && has("h2: x.md") && /Stays as it is/.test(stays) && !has("h1: x.md") && hHat("bestätigt", "h1: x.md") && hHat("repariert", "h1: x.md") && hHat("übersprungen", "h2: x.md") && !hHat("bestätigt", "h2: x.md"), `h1 umbenannt=${h1}, h2 liegt=${has("h2: x.md")}, Karte h2=${q(stays.slice(0, 80))}, Protokoll=${q(hLog)}`);

    // --- I ---
    console.log("\nI · Einstellungen");
    await cdp.evaluate(`app.setting.open(); await new Promise((r) => setTimeout(r, 500)); app.setting.openTabById(${q(PLUGIN_ID)}); await new Promise((r) => setTimeout(r, 1000)); return true;`);
    let sCdp: Cdp = cdp; let ownWindow = false;
    if (!(await cdp.evaluate<boolean>(`return Boolean(document.querySelector(".modal.mod-settings"));`))) { const win = await attachTo("settings", port, REPO_NAME); if (win) { sCdp = win; ownWindow = true; } }
    const s = await sCdp.evaluate<{ first: string | null; heads: string[]; folds: string[]; coll: number }>(`
      const root = document.querySelector(".modal.mod-settings") || document.body;
      const items = Array.from(root.querySelectorAll(".setting-item"));
      const first = items.length ? (items[0].querySelector(".setting-item-name") || {}).textContent || null : null;
      const heads = Array.from(root.querySelectorAll(".setting-item-heading .setting-item-name")).map((e) => e.textContent);
      const folds = Array.from(root.querySelectorAll(".okit-collapsible-title")).map((e) => e.textContent);
      return { first, heads, folds, coll: root.querySelectorAll(".okit-collapsible.is-collapsed").length };
    `);
    if (ownWindow) sCdp.close();
    await schliesseEinstellungen(cdp).catch(() => undefined);
    const order = ["Repair", "Exceptions", "Replacements", "Log", "Advanced"];
    const idx = order.map((h) => s.heads.indexOf(h));
    record("I Einstellungen: Hilfe-Zeile zuerst, Gruppen in der Reihenfolge der Spec", s.first === "Help" && idx.every((i, k) => i >= 0 && (k === 0 || i > idx[k - 1])) && s.coll === 3 && s.heads.every((h, i) => s.heads.indexOf(h) === i) && s.folds.every((f) => !s.heads.includes(f ?? "")), `erste=${q(s.first)}, Überschriften=${q(s.heads)}, Klappzeilen=${q(s.folds)}, eingeklappt=${s.coll}`);

    // --- K --- (390 px bei geöffneten Einstellungen; ein Desktop-Fenster mit 390 px ist kein Handy, das Gerät misst der Master)
    console.log("\nK · Einstellungen bei 390 px");
    await cdp.evaluate(`app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); return true;`);
    await setWindowSize(cdp, 390, 844);
    await cdp.evaluate(`app.setting.open(); await new Promise((r) => setTimeout(r, 500)); app.setting.openTabById(${q(PLUGIN_ID)}); await new Promise((r) => setTimeout(r, 1000)); return true;`);
    let kCdp: Cdp = cdp; let kOwnWindow = false;
    if (!(await cdp.evaluate<boolean>(`return Boolean(document.querySelector(".modal.mod-settings"));`))) { const win = await attachTo("settings", port, REPO_NAME); if (win) { kCdp = win; kOwnWindow = true; } }
    // Das Fenster der Einstellungen behält seine Breite; die 390 px entstehen durch Simulation (`withMetrics`), und nur darin wird gemessen.
    // Gemessen wird: rechte Kante jeder Zeile gegen die Fensterbreite, Rollbreite des Inhalts, kleinste Bedienelemente, Namen mit abgeschnittenem Text.
    const kMessen = `
      const root = document.querySelector(".vertical-tab-content");
      if (!root) return null;
      const rows = Array.from(root.querySelectorAll(".setting-item")).filter((e) => e.getBoundingClientRect().width > 0);
      const vw = window.innerWidth;
      const maxRight = rows.length ? Math.max(...rows.map((e) => e.getBoundingClientRect().right)) : 0;
      const ctl = Array.from(root.querySelectorAll("input:not([type=hidden]), select, button, .checkbox-container")).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
      const names = Array.from(root.querySelectorAll(".setting-item-name")).filter((e) => e.getBoundingClientRect().width > 0);
      const cut = names.filter((e) => e.scrollWidth > e.clientWidth + 1);
      const col = root.getBoundingClientRect();
      return { rows: rows.length, vw, maxRight, overflow: root.scrollWidth > root.clientWidth + 1, sw: root.scrollWidth, cw: root.clientWidth, colW: Math.round(col.width), minCtl: ctl.length ? Math.min(...ctl.map((b) => b.height)) : 0, cut: cut.length, names: names.length, cutSample: cut.slice(0, 2).map((e) => e.textContent), hoehe: Math.ceil(col.top + root.scrollHeight + 40) };
    `;
    type KMass = { rows: number; vw: number; maxRight: number; overflow: boolean; sw: number; cw: number; colW: number; minCtl: number; cut: number; names: number; cutSample: string[]; hoehe: number };
    // Die Einstellungen sind höher als das Fenster: erst die nötige Höhe messen, dann in dieser Höhe messen und aufnehmen (Breite bleibt 390 px).
    const kLauf = async (name: string, scale: number): Promise<KMass | null> => {
      const hoehe = await withMetrics(kCdp, 390, 3000, async () => { await sleep(800); return (await kCdp.evaluate<KMass | null>(kMessen))?.hoehe ?? 0; });
      const h = Math.min(Math.max(hoehe, 844), 8000);
      return withMetrics(kCdp, 390, h, async () => {
        await sleep(1200);
        const m = await kCdp.evaluate<KMass | null>(kMessen);
        if (shots && m) {
          writeFileSync(join(shots, name), await capture(kCdp, { x: 0, y: 0, width: 390, height: h }, scale));
          console.log(`  Bild: ${join(shots, name)} (Höhe ${h} px${hoehe > h ? `, gekürzt von ${hoehe}` : ""})`);
        }
        return m;
      });
    };
    const kZu = await kLauf("settings-390.png", 2);
    // Alle Gruppen aufklappen: das ist der strengere Fall für Zeilen mit Zahlenfeldern, Ersetzungsregeln und Wertlisten.
    await kCdp.evaluate(`document.querySelectorAll(".okit-collapsible.is-collapsed .okit-collapsible-title").forEach((t) => t.click()); await new Promise((r) => setTimeout(r, 600)); return true;`);
    const kUnaufgeklappt = await kCdp.evaluate<number>(`return document.querySelectorAll(".okit-collapsible.is-collapsed").length;`);
    const kOffen = await kLauf("settings-390-offen.png", 1);
    // N: ein Zurücksetzen (Ersetzungsregel, zeichnet die Einstellungen neu) und das Wiederöffnen dürfen die offenen Gruppen nicht zuklappen.
    // Sonde: überlebt ein gespeichertes `false` im lokalen Speicher? (Ursache für ein Zuklappen trotz gespeichertem Zustand)
    const nSonde = await cdp.evaluate<{ falsch: unknown; wahr: unknown; text: unknown }>(`app.saveLocalStorage("filename-sanitizer-sonde", false); const falsch = app.loadLocalStorage("filename-sanitizer-sonde"); app.saveLocalStorage("filename-sanitizer-sonde", true); const wahr = app.loadLocalStorage("filename-sanitizer-sonde"); app.saveLocalStorage("filename-sanitizer-sonde", "open"); const text = app.loadLocalStorage("filename-sanitizer-sonde"); app.saveLocalStorage("filename-sanitizer-sonde", null); return { falsch, wahr, text };`);
    const nGespeichert = await cdp.evaluate<Record<string, unknown>>(`return { replacements: app.loadLocalStorage("filename-sanitizer-fold-replacements"), log: app.loadLocalStorage("filename-sanitizer-fold-log"), advanced: app.loadLocalStorage("filename-sanitizer-fold-advanced") };`);
    const nVorReset = await kCdp.evaluate<number>(`return document.querySelectorAll(".okit-collapsible.is-collapsed").length;`);
    const nReset = await kCdp.evaluate<boolean>(`const sec = Array.from(document.querySelectorAll(".okit-collapsible")).find((x) => /replacement/i.test(((x.querySelector(".okit-collapsible-title") || {}).textContent || "").trim())); const b = sec ? sec.querySelector(".extra-setting-button") : null; if (b) b.click(); await new Promise((r) => setTimeout(r, 1200)); return Boolean(b);`);
    const nNachReset = await kCdp.evaluate<{ zu: number; gruppen: number }>(`return { zu: document.querySelectorAll(".okit-collapsible.is-collapsed").length, gruppen: document.querySelectorAll(".okit-collapsible").length };`);
    if (kOwnWindow) kCdp.close();
    await schliesseEinstellungen(cdp).catch(() => undefined);
    await cdp.evaluate(`app.setting.open(); await new Promise((r) => setTimeout(r, 500)); app.setting.openTabById(${q(PLUGIN_ID)}); await new Promise((r) => setTimeout(r, 1200)); return true;`);
    let nCdp: Cdp = cdp; let nOwn = false;
    if (!(await cdp.evaluate<boolean>(`return Boolean(document.querySelector(".modal.mod-settings"));`))) { const win = await attachTo("settings", port, REPO_NAME); if (win) { nCdp = win; nOwn = true; } }
    const nWieder = await nCdp.evaluate<{ zu: number; gruppen: number }>(`return { zu: document.querySelectorAll(".okit-collapsible.is-collapsed").length, gruppen: document.querySelectorAll(".okit-collapsible").length };`);
    // Zustand zurück: die Gruppen wieder einklappen (lokaler Speicher), damit der nächste Lauf wie ein erster beginnt.
    await nCdp.evaluate(`document.querySelectorAll(".okit-collapsible:not(.is-collapsed) .okit-collapsible-title").forEach((t) => t.click()); return true;`);
    if (nOwn) nCdp.close();
    await schliesseEinstellungen(cdp).catch(() => undefined);
    record("N Einstellungen: aufgeklappte Gruppen bleiben nach einem Zurücksetzen und nach dem Wiederöffnen offen", nReset && nVorReset === 0 && nNachReset.gruppen === 3 && nNachReset.zu === 0 && nWieder.gruppen === 3 && nWieder.zu === 0,
      `Speicher-Sonde false→${q(nSonde.falsch)}, true→${q(nSonde.wahr)}, "open"→${q(nSonde.text)}; gespeichert=${q(nGespeichert)}; vor dem Zurücksetzen zu=${nVorReset}, Knopf gefunden=${nReset}, danach zu=${nNachReset.zu}/${nNachReset.gruppen}, nach Wiederöffnen zu=${nWieder.zu}/${nWieder.gruppen}`);
    const kOk = (m: KMass | null): boolean => m !== null && m.rows > 0 && m.vw === 390 && !m.overflow && m.maxRight <= m.vw + 1;
    const kText = (m: KMass | null): string => (m ? `Fenster ${m.vw} px, Spalte ${m.colW} px, Zeilen=${m.rows}, Überlauf=${m.overflow} (${m.sw}/${m.cw}), rechte Kante ${Math.round(m.maxRight)}/${m.vw}, kleinstes Bedienelement ${Math.round(m.minCtl)} px, abgeschnittene Namen ${m.cut}/${m.names} ${q(m.cutSample)}` : "nichts gemessen");
    record("K Einstellungen bei 390 px: kein seitliches Überlaufen, auch mit allen Gruppen aufgeklappt", kOk(kZu) && kOk(kOffen) && kUnaufgeklappt === 0 && (kOffen?.rows ?? 0) > (kZu?.rows ?? 0), `eingeklappt: ${kText(kZu)}; aufgeklappt (noch zu: ${kUnaufgeklappt}): ${kText(kOffen)}`);

    }

    // --- S7 / J ---
    console.log("\nS7 · Startscan mit Massendateien");
    for (let i = 0; i < BULK_VALID; i++) w(`bulk/n${String(i).padStart(5, "0")}.md`, "x\n");
    for (let i = 0; i < BULK_BAD; i++) w(`bulkbad/b: ${String(i).padStart(4, "0")}.md`, "x\n");
    // Warten auf den Indexstand statt auf eine feste Zeit: fertig, wenn die Dateizahl das Soll hat und über zwei Messungen gleich bleibt;
    // abgebrochen wird nur, wenn sich die Zahl 120 s lang nicht bewegt (Obergrenze 30 Minuten). Belege für die feste Zeit: 17.069 und 15.555 von 17.245 nach 420 s.
    const t0Index = Date.now();
    const indexed = await (async (): Promise<number | null> => {
      let last = -1; let lastChange = Date.now(); let gleich = 0;
      while (Date.now() - t0Index < 1800000) {
        const n = await cdp.evaluate<number>(`return app.vault.getFiles().length;`);
        if (n !== last) { last = n; lastChange = Date.now(); gleich = 0; } else gleich++;
        if (n >= BULK_VALID + BULK_BAD && gleich >= 2) return n;
        if (Date.now() - lastChange > 120000) return null;
        await sleep(2000);
      }
      return null;
    })();
    const indexSekunden = Math.round((Date.now() - t0Index) / 1000);
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) runs.push(await cdp.evaluate<number>(`const t = performance.now(); await ${P}.engine.scanNow(); return Math.round(performance.now() - t);`));
    const total = await cdp.evaluate<number>(`return app.vault.getFiles().length;`);
    const pend = await cdp.evaluate<number>(`return ${P}.engine.pending().length;`);
    record("S7 Startscan bei 17.000 Dateien (Dauer gemessen)", indexed !== null && pend >= BULK_BAD, `Index nach ${indexSekunden} s, Dateien im Index=${total}, Scan je Lauf=${runs.join("/")} ms, Prüfliste=${pend} Einträge`);

    console.log("\nJ · 390 px");
    // Desktop-Fenster mit 390 px lässt den Seitenleisten fast die ganze Breite (Messung 1: Ansicht 22 px breit); ein Handy gibt dem Hauptbereich die ganze Breite.
    await cdp.evaluate(`app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); return true;`);
    await setWindowSize(cdp, 390, 844);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-review-and-log`)}); return true;`);
    const t0 = Date.now();
    const cards = await pollUntil<number>(cdp, `const n = document.querySelectorAll(".okit-review-card").length; return n >= ${BULK_BAD} ? n : null;`, 120000, 300);
    const renderMs = Date.now() - t0;
    await sleep(500);
    const m = await cdp.evaluate<{ overflow: boolean; sw: number; cw: number; maxRight: number; vw: number; minBtn: number; firstCardH: number }>(`
      const root = Array.from(document.querySelectorAll(".fsan-panel")).find((el) => el.offsetParent !== null);
      const cards = Array.from(document.querySelectorAll(".okit-review-card"));
      const vw = window.innerWidth;
      const maxRight = Math.max(...cards.slice(0, 40).map((c) => c.getBoundingClientRect().right));
      const btns = Array.from(document.querySelectorAll(".okit-review-card button")).slice(0, 12);
      const minBtn = Math.min(...btns.map((b) => b.getBoundingClientRect().height));
      return { overflow: root ? root.scrollWidth > root.clientWidth + 1 : true, sw: root ? root.scrollWidth : 0, cw: root ? root.clientWidth : 0, maxRight, vw, minBtn, firstCardH: cards[0] ? cards[0].getBoundingClientRect().height : 0 };
    `);
    if (shots) {
      const png = await capture(cdp);
      writeFileSync(join(shots, "review-390.png"), png);
      console.log(`  Bild: ${join(shots, "review-390.png")}`);
    }
    record("J Ansicht bei 390 px: 245 Karten, kein seitliches Überlaufen, Knöpfe greifbar", cards !== null && cards >= BULK_BAD && !m.overflow && m.maxRight <= m.vw + 1 && m.minBtn >= 28, `Karten=${cards}, Aufbau ${renderMs} ms, Überlauf=${m.overflow} (${m.sw}/${m.cw}), rechte Kante ${Math.round(m.maxRight)}/${m.vw}, kleinster Knopf ${Math.round(m.minBtn)} px, Kartenhöhe ${Math.round(m.firstCardH)} px`);

    // --- M --- (die 245 Karten stehen noch in der Ansicht)
    console.log("\nM · Scroll und Fokus bei 245 Karten");
    const mm = await cdp.evaluate<{ ok: boolean; vorher: number; nachher: number; id: string; aktiv: string | null; knopf: string | null; karten: number; ms: number }>(`
      const cards = Array.from(document.querySelectorAll(".okit-review-card")).filter((c) => c.offsetParent !== null);
      if (cards.length < 150) return { ok: false, vorher: 0, nachher: 0, id: "", aktiv: null, knopf: null, karten: cards.length, ms: 0 };
      let scroller = cards[0].parentElement;
      while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
      if (!scroller) return { ok: false, vorher: 0, nachher: 0, id: "", aktiv: null, knopf: null, karten: cards.length, ms: 0 };
      scroller.scrollTop = Math.floor(scroller.scrollHeight * 0.4);
      await new Promise((r) => setTimeout(r, 300));
      const card = cards.find((c) => c.getBoundingClientRect().top > 100) || cards[120];
      const id = card.getAttribute("data-id");
      const btn = card.querySelector(".okit-review-reject");
      btn.focus();
      const vorher = scroller.scrollTop;
      const t0 = performance.now();
      btn.click();
      // Neuzeichnen: der angeklickte Knopf ist ausgetauscht, sobald seine Karte neu gebaut wurde (Messung ohne die Wartezeit danach).
      let neu = 0;
      while (btn.isConnected && neu < 5000) { await new Promise((r) => setTimeout(r, 10)); neu = Math.round(performance.now() - t0); }
      const neuMs = btn.isConnected ? -1 : neu;
      await new Promise((r) => setTimeout(r, 600));
      const a = document.activeElement;
      const c2 = a && a.closest ? a.closest("[data-id]") : null;
      return { ok: true, vorher, nachher: scroller.scrollTop, id, aktiv: c2 ? c2.getAttribute("data-id") : null, knopf: a ? a.className : null, karten: document.querySelectorAll(".okit-review-card").length, ms: neuMs };
    `);
    if (shots) {
      const png = await capture(cdp);
      writeFileSync(join(shots, "review-390-nach-ablehnen.png"), png);
      console.log(`  Bild: ${join(shots, "review-390-nach-ablehnen.png")}`);
    }
    record("M Prüfliste mit 245 Karten: Scrollposition und Fokus bleiben nach Ablehnen einer Karte", mm.ok && mm.vorher > 500 && Math.abs(mm.nachher - mm.vorher) <= 2 && mm.aktiv === mm.id && /okit-review-reject/.test(mm.knopf ?? "") && mm.karten >= BULK_BAD,
      `Karten=${mm.karten}, Scroll vorher ${mm.vorher} → nachher ${mm.nachher}, Karte ${q(mm.id)} → Fokus auf ${q(mm.aktiv)} (${q(mm.knopf)}), Klick bis die Karte neu gebaut ist ${mm.ms} ms (Abtastung 10 ms, -1 = nicht innerhalb 5 s)`);
  } finally {
    await zustand.schliesse();
    if (istAbgebrochen()) return;
    cdp.close();
  }
  for (const wn of warnungen) console.log(`  ⚠ ${wn}`);
  bilanz.abschluss();
}

runDriver(main);
