/**
 * Aufnahme-Treiber für die README-Bilder — fährt den Vertrag aus `docs/images/README.md` gegen ein LAUFENDES Obsidian.
 * Der Treiber ist wie im GUI-Smoke der „fremde Schreiber“: Dateien entstehen mit Node-`fs` im Vault, nicht über Obsidians API.
 *
 * ## Zweitinstanz (eigenes Profil, eigener Port — NICHT die reguläre Instanz anfassen; `--port` ist Pflicht)
 *
 *   npm run build && npm run shots -- --setup
 *   UD=<Profilordner>; mkdir -p "$UD"; cp ~/Library/Application\ Support/obsidian/obsidian-*.asar "$UD"/
 *   node -e 'require("fs").writeFileSync(process.argv[1]+"/obsidian.json",JSON.stringify({vaults:{"fsan":{path:process.argv[2],ts:Date.now(),open:true}},language:"en"}))' "$UD" "$STAGING_VAULTS_DIR/filename-sanitizer"
 *   python3 ~/.claude/hooks/obsidian-cdp-lock.py acquire --label filename-sanitizer --intent "README-Bilder" --exclusive focus --port <Port> --ttl 900 --warten 300 && \
 *   { /Applications/Obsidian.app/Contents/MacOS/Obsidian --user-data-dir="$UD" --remote-debugging-port=<Port> --lang=en-US & } && npm run shots -- --port <Port>
 *   python3 ~/.claude/hooks/obsidian-cdp-lock.py release --port <Port>; pkill -f "user-data-dir=$UD"
 *
 * Der Staging-Vault ist derselbe wie der des GUI-Smoke (`stagingVaultDir` gibt je Repo genau einen); beide bauen ihn aus `fixtures/vault/`.
 * Die Schau-Namen stehen unten in diesem Rezept (generisch und englisch), nicht im Fixture, damit der Smoke seine Zählung behält.
 * Ein Lauf nimmt alle vier Bilder auf; `--only <datei>` nimmt eines.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cwd } from "node:process";

import { parseArgs, runDriver } from "../../tools/obsidian-cdp/bilanz.js";
import { Cdp, attachTo, bereiteInstanzVor, clearNotices, pollUntil, requireUntil, requireVisible, schliesseEinstellungen } from "../../tools/obsidian-cdp/cdp.js";
import { boxOf, capture, setWindowSize, withMetrics, writeShot, type Rect } from "../../tools/obsidian-cdp/shot.js";
import { buildVault, requireEigenerBuild, stagingVaultDir } from "../../tools/obsidian-cdp/vault.js";

const REPO_NAME = "filename-sanitizer";
const PLUGIN_ID = "filename-sanitizer";
const REPO_ROOT = cwd();
const FIXTURE_DIR = join(REPO_ROOT, "fixtures/vault");
const OUT_DIR = join(REPO_ROOT, "docs/images");
const QUIET_MS = 1000;
const CAPTURE_WIDTH = 1200;
const THUMB_WIDTH = 380;
const PADDING = 12;
const FENSTER_BREITE = 1200;
const FENSTER_HOEHE = 760;

/** Namen, die schon vor dem ersten Start da sind: sie landen als „Existing name“ in der Prüfliste. */
const ALTBESTAND = [
  "Meeting notes: Q3 plan.md",
  "Reading list [2026] #books.md",
  "What is next?.md",
  "Budget | draft.md",
];
/** Namen, die ein fremder Schreiber nach dem Start anlegt: sie werden repariert und stehen im Protokoll. */
const NEU = [
  "Release plan: v2.md",
  "Interview \"notes\" 12:30.md",
  "Ideas #1 [raw].md",
  "Standup: Monday.md",
];
/** Gültige Notizen, damit der Explorer nicht leer wirkt. */
const GUELTIG = ["Welcome.md", "Projects/Roadmap.md", "Projects/Backlog.md", "Daily/2026-11-03.md"];

const q = (s: unknown): string => JSON.stringify(s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const P = `app.plugins.plugins[${q(PLUGIN_ID)}]`;

interface Motiv { name: string; klasse: "hero" | "feature" | "detail"; imSettingsFenster?: boolean; run: (cdp: Cdp) => Promise<Rect | { png: Buffer } | null> }

function setup(): void {
  const vaultDir = stagingVaultDir(REPO_NAME);
  const log = buildVault({ repoRoot: REPO_ROOT, vaultDir, fixtureDir: FIXTURE_DIR, pluginId: PLUGIN_ID });
  console.log(`Staging-Vault gebaut: ${vaultDir}`);
  for (const l of log) console.log(`  · ${l}`);
  console.log("\nZweitinstanz starten (Rezept im Dateikopf), dann:\n  npm run shots -- --port <Port>");
}

const SHOTS: Motiv[] = [
  {
    name: "hero.png",
    klasse: "hero",
    async run(cdp) {
      await oeffneAnsicht(cdp, "review");
      await explorerOffen(cdp);
      await clearNotices(cdp);
      await sleep(600);
      return inhaltBox(cdp, true);
    },
  },
  {
    name: "review.png",
    klasse: "feature",
    async run(cdp) {
      await oeffneAnsicht(cdp, "review");
      await cdp.evaluate(`app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); return true;`);
      await clearNotices(cdp);
      await sleep(600);
      return inhaltBox(cdp, false);
    },
  },
  {
    name: "log.png",
    klasse: "feature",
    async run(cdp) {
      await oeffneAnsicht(cdp, "log");
      await cdp.evaluate(`app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); return true;`);
      await requireUntil(cdp, `document.querySelectorAll(".workspace-leaf.mod-active .okit-hub-panel:not([hidden]) *").length > 8`, "Der Tab Protokoll zeigt keinen Inhalt", 8000, 200);
      await clearNotices(cdp);
      await sleep(800);
      return inhaltBox(cdp, false);
    },
  },
  {
    name: "settings.png",
    klasse: "detail",
    imSettingsFenster: true,
    async run(cdp) {
      const ok = await pollUntil(cdp, `return document.querySelector(".vertical-tab-content .setting-item") ? true : null;`, 8000, 200).catch(() => null);
      if (!ok) return null;
      // Der Bildschirm begrenzt das Fenster (gemessen: 949 px), die Einstellungen sind höher. Darum wird die Fenstergröße für die
      // Aufnahme simuliert (`withMetrics`); das Bild entsteht innerhalb der Simulation.
      return withMetrics(cdp, 900, 1250, async () => {
        await sleep(1200);
        // Rahmen um den Inhalt der Gruppen, ohne Titelleiste darüber, Rollbalken rechts und leeren Streifen darunter.
        const r = await cdp.evaluate<{ x: number; y: number; right: number; bottom: number } | null>(`
          const root = document.querySelector(".vertical-tab-content");
          if (!root) return null;
          const bs = Array.from(root.querySelectorAll(".setting-group, .setting-item, .setting-item-heading")).map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
          if (!bs.length) return null;
          return { x: Math.min(...bs.map((b) => b.left)), y: Math.min(...bs.map((b) => b.top)), right: Math.max(...bs.map((b) => b.right)), bottom: Math.max(...bs.map((b) => b.bottom)) };
        `);
        if (!r) return null;
        const box: Rect = { x: r.x - 24, y: r.y - 24, width: r.right - r.x + 48, height: r.bottom - r.y + 48 };
        return { png: await capture(cdp, box, 2) };
      });
    },
  },
];

/** Fensterbreite des Hauptbereichs, Höhe bis zum Ende des Inhalts (kein leerer Streifen darunter). */
async function inhaltBox(cdp: Cdp, mitSeitenleiste: boolean): Promise<Rect | null> {
  const r = await cdp.evaluate<{ x: number; y: number; w: number; bottom: number } | null>(`
    const root = document.querySelector(${q(mitSeitenleiste ? ".workspace" : ".workspace-split.mod-root")});
    const panel = Array.from(document.querySelectorAll(".okit-hub-panel")).find((el) => el.offsetParent !== null);
    if (!root || !panel) return null;
    const rb = root.getBoundingClientRect();
    const kids = Array.from(panel.querySelectorAll("*")).map((e) => e.getBoundingClientRect()).filter((b) => b.height > 0);
    return { x: rb.left, y: rb.top, w: rb.width, bottom: Math.max(...kids.map((b) => b.bottom)) };
  `);
  if (!r) return null;
  return { x: r.x, y: r.y, width: r.w, height: r.bottom - r.y + 16 };
}

/** Öffnet die Ansicht und wählt den Tab (`review` oder `log`). */
async function oeffneAnsicht(cdp: Cdp, tab: "review" | "log"): Promise<void> {
  await cdp.evaluate(`await ${P}.activateView(${q(tab)}); return true;`);
  await requireUntil(cdp, `document.querySelector('.okit-hub-tab[data-tab=${q(tab)}][aria-selected="true"]')`, `Der Tab ${tab} wurde nicht gewählt`, 8000, 200);
}

/** Zeigt die linke Seitenleiste mit dem Datei-Explorer. */
async function explorerOffen(cdp: Cdp): Promise<void> {
  await cdp.evaluate(`
    app.workspace.rightSplit.collapse();
    app.workspace.leftSplit.expand();
    const l = app.workspace.getLeavesOfType("file-explorer")[0];
    if (l) app.workspace.revealLeaf(l);
    return true;
  `);
}

async function settingsVerbinden(cdp: Cdp, port: number): Promise<{ ziel: Cdp; eigenes: boolean }> {
  await cdp.evaluate(`app.setting.open(); await new Promise((r) => setTimeout(r, 500)); app.setting.openTabById(${q(PLUGIN_ID)}); await new Promise((r) => setTimeout(r, 1000)); return true;`);
  if (await cdp.evaluate<boolean>(`return Boolean(document.querySelector(".modal.mod-settings"));`)) return { ziel: cdp, eigenes: false };
  const win = await attachTo("settings", port, REPO_NAME);
  if (!win) throw new Error("Einstellungen weder als Modal noch als eigenes Fenster gefunden.");
  return { ziel: win, eigenes: true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("setup")) { setup(); return; }
  if (args.has("list")) { for (const s of SHOTS) console.log(`${s.name}  (${s.klasse})`); return; }
  const portArg = args.value("port");
  if (!portArg || !Number.isInteger(Number(portArg))) throw new Error("--port <Port> ist Pflicht (Zweitinstanz) — kein Standardport.");
  const port = Number(portArg);
  const nur = args.value("only");
  mkdirSync(OUT_DIR, { recursive: true });

  const cdp = await attachTo("workspace", port, REPO_NAME);
  if (!cdp) throw new Error(`Kein Obsidian-Hauptfenster auf Port ${port} für Vault „${REPO_NAME}“.`);
  let settingsCdp: Cdp | null = null;
  const fehlend: string[] = [];
  try {
    await requireVisible(cdp);
    const klar = await bereiteInstanzVor(cdp, { pluginIds: [PLUGIN_ID], nurVault: REPO_NAME, sprache: "en" });
    console.log(`  (${klar.hinweis})`);
    const info = await cdp.evaluate<{ basePath: string; configDir: string; version: string; lang: string }>(`return { basePath: app.vault.adapter.basePath, configDir: app.vault.configDir, version: (typeof electron !== "undefined" ? "" : "") + (window.navigator.userAgent.match(/Obsidian\\/([\\d.]+)/) || [,""])[1], lang: document.documentElement.lang };`);
    const vaultDir = info.basePath;
    console.log(`Obsidian ${info.version}, Oberfläche ${info.lang}, Vault ${vaultDir}`);
    if (!info.lang.startsWith("en")) throw new Error(`Die Oberfläche steht auf "${info.lang}", die Bilder müssen englisch sein (README.md ist die kanonische Fassung).`);
    requireEigenerBuild(join(vaultDir, info.configDir, "plugins", PLUGIN_ID, "main.js"), join(REPO_ROOT, "main.js"), (m) => console.log(`  ⚠ ${m}`));
    await setWindowSize(cdp, FENSTER_BREITE, FENSTER_HOEHE);

    // Ausgangslage: Plugin aus, Gerätewerte weg (= erster Start), Schau-Dateien neu.
    await cdp.evaluate(`try { await app.plugins.disablePlugin(${q(PLUGIN_ID)}); } catch {} for (const k of ["repairs", "name", "snapshot", "policy"]) app.saveLocalStorage("filename-sanitizer-" + k, null); return true;`);
    for (const d of ["Filename Sanitizer", "Projects", "Daily", "Ausnahme"]) rmSync(join(vaultDir, d), { recursive: true, force: true });
    for (const f of readdirSync(vaultDir)) if (f.endsWith(".md") && f !== "ok.md" && f !== "Links.md") rmSync(join(vaultDir, f), { force: true });
    writeFileSync(join(vaultDir, info.configDir, "plugins", PLUGIN_ID, "data.json"), JSON.stringify({ quietMs: QUIET_MS, mode: "auto" }));
    const w = (rel: string, text: string): void => { const f = join(vaultDir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
    for (const rel of GUELTIG) w(rel, `# ${rel.replace(/\.md$/, "").split("/").pop()}\n\nA short note.\n`);
    for (const n of ALTBESTAND) w(n, `# ${n.replace(/\.md$/, "")}\n\nWritten before the plugin was installed.\n`);
    await sleep(1500);
    await cdp.evaluate(`await app.plugins.enablePlugin(${q(PLUGIN_ID)}); return true;`);
    const geladen = await cdp.evaluate<boolean>(`return Boolean(${P});`);
    if (!geladen) throw new Error("Plugin nicht geladen (Restricted Mode?) — ohne Plugin zeigte jedes Bild eine Oberfläche ohne Filename Sanitizer.");
    await requireUntil(cdp, `${P}.engine.pending().length >= ${ALTBESTAND.length}`, "Der Altbestand steht nicht in der Prüfliste", 12000, 300);
    // Ein fremder Schreiber legt Dateien an; sie werden nach der Ruhezeit repariert und landen im Protokoll.
    for (const n of NEU) { w(n, `# ${n.replace(/\.md$/, "")}\n\nCreated by another tool.\n`); await sleep(400); }
    await requireUntil(cdp, `app.vault.getMarkdownFiles().some((f) => f.name === "Release plan — v2.md") && app.vault.getMarkdownFiles().some((f) => f.name === "Standup — Monday.md")`, "Die fremd angelegten Dateien wurden nicht repariert", QUIET_MS + 12000, 300);
    await sleep(3500); // das Popup der Reparatur soll vorbei sein, sonst ragt es ins Bild

    const geplant = SHOTS.filter((s) => !nur || s.name === nur || s.name === `${nur}.png`);
    if (!geplant.length) throw new Error(`Kein Motiv namens "${nur}". --list zeigt den Vertrag.`);
    for (const shot of geplant) {
      console.log(`  ${shot.name} …`);
      let ziel = cdp;
      if (shot.imSettingsFenster) {
        if (!settingsCdp) {
          const s = await settingsVerbinden(cdp, port);
          settingsCdp = s.ziel;
          console.log(`      · Einstellungen ${s.eigenes ? "als eigenes Fenster" : "als Modal im Hauptfenster"}`);
        }
        ziel = settingsCdp;
        await ziel.send("Page.bringToFront");
      }
      const box = await shot.run(ziel);
      if (!box) { console.log("      ✗ Zustand kam nicht zustande — kein Bild geschrieben"); fehlend.push(shot.name); continue; }
      const png = "png" in box ? box.png : await capture(ziel, box, 2);
      const hinweis = await writeShot(ziel, shot.name, png, { outDir: OUT_DIR, captureWidth: CAPTURE_WIDTH, thumbWidth: THUMB_WIDTH, thumb: shot.klasse === "detail" });
      console.log(`      ✓ ${hinweis}`);
    }
  } finally {
    if (settingsCdp && settingsCdp !== cdp) settingsCdp.close();
    try { await schliesseEinstellungen(cdp); } catch { /* schon zu */ }
    try { await cdp.evaluate(`app.workspace.leftSplit.expand(); app.workspace.rightSplit.expand(); return true;`); } catch { /* Fenster weg */ }
    cdp.close();
  }
  if (fehlend.length) { console.log(`\n${fehlend.length} Motiv(e) ohne Bild: ${fehlend.join(", ")}`); process.exit(1); }
  console.log("\nJedes Bild jetzt SELBST ansehen: Zuschnitt, Lesbarkeit, nichts Privates, Auslieferungszustand statt vom Treiber gesetzter Werte.");
  if (!existsSync(OUT_DIR)) process.exit(1);
}

runDriver(main);
