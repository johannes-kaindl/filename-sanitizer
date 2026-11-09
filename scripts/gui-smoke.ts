/**
 * GUI-Smoke — fährt die Prüfpunkte aus docs/SMOKE.md gegen ein LAUFENDES Obsidian (CORE-TEST-02 b).
 * Der Treiber ist selbst der „fremde Schreiber“: Dateien entstehen mit Node-`fs` im Vault, nicht über Obsidians API.
 *
 * ## Zweitinstanz (eigenes Profil, eigener Port — NICHT die reguläre Instanz anfassen; `--port` ist Pflicht)
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
import { Cdp, attachTo, beimAbbruch, bereiteInstanzVor, clearNotices, istAbgebrochen, notices, pollUntil, requireVisible, schliesseEinstellungen } from "../../tools/obsidian-cdp/cdp.js";
import { capture, setWindowSize } from "../../tools/obsidian-cdp/shot.js";
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
  "A Altbestand beim ersten Start unberührt und in der Prüfliste",
  "B Extern angelegtes „c1: rest.md“ wird nach der Ruhezeit „c1 — rest.md“, Link und Alias folgen, Kontrolldatei bleibt; eine Datei mit beliebiger Endung („c2: fremd.foo“) wird ebenso repariert",
  "C Ausnahme-Ordner bleibt, derselbe Name außerhalb wird repariert",
  "R Regeländerung macht einen Bestandsnamen ungültig: er bleibt liegen und steht in der Prüfliste, eine danach angelegte Datei wird repariert",
  "D alwaysUpdateLinks aus: kein Dialog, Datei bleibt, Prüfliste nennt den Grund; danach löst die Liste aus",
  "E Mehrere Reparaturen ergeben ein gebündeltes Popup",
  "F Das Protokoll (.jsonl) enthält die Zeile, die Kontrolldatei nicht",
  "G app.plugins.plugins[…].api antwortet (sanitizeName, checkName, Fehlerwert)",
  "H Haken weg lässt die Datei stehen, der angehakte Eintrag wird umbenannt",
  "I Einstellungen: Hilfe-Zeile zuerst, Gruppen in der Reihenfolge der Spec",
  "S7 Startscan bei 17.000 Dateien (Dauer gemessen)",
  "J Ansicht bei 390 px: 245 Karten, kein seitliches Überlaufen, Knöpfe greifbar",
] as const;

const bilanz = createBilanz({ punkte: PUNKTE });
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
    record("F Das Protokoll (.jsonl) enthält die Zeile, die Kontrolldatei nicht", Boolean(rest) && rest?.event === "repariert" && rest?.v === 1 && !parsed.some((l) => l === null) && !parsed.some((l) => l?.oldPath === "kontrolle.md"),
      `Zeilen=${lines.length}, Zeile c1=${q(rest ? { event: rest.event, newPath: rest.newPath, trigger: rest.trigger } : null)}`);

    // --- G ---
    console.log("\nG · API");
    const g = await cdp.evaluate<{ s: unknown; c: unknown; bad: unknown; sync: boolean }>(`const a = ${P}.api; const r = a.sanitizeName("a: b.md", { caller: "smoke" }); return { s: r, c: a.checkName("ok.md"), bad: a.sanitizeName("a: b.md", { caller: "" }), sync: !(r instanceof Promise) };`);
    const gs = g.s as { name?: string; changed?: boolean };
    record("G app.plugins.plugins[…].api antwortet (sanitizeName, checkName, Fehlerwert)", gs.name === "a — b.md" && gs.changed === true && (g.c as { valid?: boolean }).valid === true && (g.bad as { error?: string }).error === "invalid-input" && g.sync, `sanitize=${q(gs)}, check=${q(g.c)}, leerer caller=${q(g.bad)}`);

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
    record("H Haken weg lässt die Datei stehen, der angehakte Eintrag wird umbenannt", h1 && has("h2: x.md") && /Stays as it is/.test(stays) && !has("h1: x.md"), `h1 umbenannt=${h1}, h2 liegt=${has("h2: x.md")}, Karte h2=${q(stays.slice(0, 80))}`);

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

    // --- S7 / J ---
    console.log("\nS7 · Startscan mit Massendateien");
    for (let i = 0; i < BULK_VALID; i++) w(`bulk/n${String(i).padStart(5, "0")}.md`, "x\n");
    for (let i = 0; i < BULK_BAD; i++) w(`bulkbad/b: ${String(i).padStart(4, "0")}.md`, "x\n");
    const indexed = await pollUntil<number>(cdp, `const n = app.vault.getFiles().length; return n >= ${BULK_VALID + BULK_BAD} ? n : null;`, 420000, 2000);
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) runs.push(await cdp.evaluate<number>(`const t = performance.now(); await ${P}.engine.scanNow(); return Math.round(performance.now() - t);`));
    const total = await cdp.evaluate<number>(`return app.vault.getFiles().length;`);
    const pend = await cdp.evaluate<number>(`return ${P}.engine.pending().length;`);
    record("S7 Startscan bei 17.000 Dateien (Dauer gemessen)", indexed !== null && pend >= BULK_BAD, `Dateien im Index=${total}, Scan je Lauf=${runs.join("/")} ms, Prüfliste=${pend} Einträge`);

    console.log("\nJ · 390 px");
    // Desktop-Fenster mit 390 px lässt den Seitenleisten fast die ganze Breite (Messung 1: Ansicht 22 px breit); ein Handy gibt dem Hauptbereich die ganze Breite.
    await cdp.evaluate(`app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); return true;`);
    await setWindowSize(cdp, 390, 844);
    await cdp.evaluate(`app.commands.executeCommandById(${q(`${PLUGIN_ID}:open-review-and-log`)}); return true;`);
    const t0 = Date.now();
    const cards = await pollUntil<number>(cdp, `const n = document.querySelectorAll(".okit-review-card").length; return n >= ${BULK_BAD} ? n : null;`, 30000, 300);
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
  } finally {
    await zustand.schliesse();
    if (istAbgebrochen()) return;
    cdp.close();
  }
  for (const wn of warnungen) console.log(`  ⚠ ${wn}`);
  bilanz.abschluss();
}

runDriver(main);
