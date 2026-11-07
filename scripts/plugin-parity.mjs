#!/usr/bin/env node
// Parity check: the ts-plugin must show the same diagnostics as `abfc check`.
//
//   node scripts/plugin-parity.mjs --project <dir> [--project <dir> ...]
//
// Per project it runs `abfc check --json` and an in-process language service with the plugin, then compares per file
//   (a) the abfc diagnostics (every code except ABFC2000 and the lock codes ABFC3001-3003, with a span) by (code, file, line, col) and
//   (b) the TypeScript diagnostics (check's ABFC2000 "[TSnnnn]" vs the language service's syntactic + semantic errors
//       and warnings) by (TS code, file, line, col).
// Prints the counts and every mismatch; exits 1 on any mismatch. The project is only read: a project without an
// abf.config.json (the compiler test fixtures) is compared through a temporary copy with a config added.
// Requires `npm run build`.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const pluginPath = join(repo, "packages", "ts-plugin", "dist", "src", "index.js");
const binPath = join(repo, "packages", "cli", "dist", "src", "bin.js");
if (!existsSync(pluginPath) || !existsSync(binPath)) {
  console.error("plugin-parity: run `npm run build` first");
  process.exit(2);
}
const plugin = require(pluginPath);

const fwd = (p) => p.replaceAll("\\", "/");

function projectsFromArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1] !== undefined) out.push(resolve(argv[++i]));
    else {
      console.error(`plugin-parity: unexpected argument ${argv[i]}\nusage: node scripts/plugin-parity.mjs --project <dir> [--project <dir> ...]`);
      process.exit(2);
    }
  }
  if (out.length === 0) {
    console.error("usage: node scripts/plugin-parity.mjs --project <dir> [--project <dir> ...]");
    process.exit(2);
  }
  return out;
}

/** What `abfc check --json` says: ABFC keys and TS keys, plus the counts of what is out of scope. */
function runCheck(dir) {
  const r = spawnSync(process.execPath, [binPath, "check", "--json", "--project", dir], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    throw new Error(`abfc check printed no JSON (exit ${r.status}): ${r.stdout.slice(0, 400)} ${r.stderr.slice(0, 400)}`);
  }
  const abfc = new Set();
  const tsKeys = new Set();
  let skipped = 0;
  for (const d of doc.diagnostics) {
    if (d.code === "ABFC2000") {
      const m = /^\[TS(\d+)\]/.exec(d.message);
      if (m === null || d.span === undefined) {
        skipped++;
        continue;
      }
      tsKeys.add(`TS${m[1]}|${d.span.file}|${d.span.line}:${d.span.col}`);
    } else if (/^ABFC300[123]$/.test(d.code) || d.span === undefined) {
      skipped++;
    } else {
      abfc.add(`${d.code}|${d.span.file}|${d.span.line}:${d.span.col}`);
    }
  }
  return { abfc, tsKeys, skipped, exit: r.status, ok: doc.ok };
}

/** A language service over the project on disk, like tsserver would run it. */
function createLs(projectDir) {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(projectDir, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  if (!parsed) throw new Error(`cannot read ${join(projectDir, "tsconfig.json")}`);
  const host = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (f) => (existsSync(f) ? String(statSync(f).mtimeMs) : "0"),
    getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
    getCurrentDirectory: () => projectDir,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return { ls: ts.createLanguageService(host, ts.createDocumentRegistry()), host };
}

/** What the language service with the plugin says, over every file of its program that is not a default library. */
async function runPlugin(dir) {
  const made = createLs(dir);
  const log = [];
  const created = plugin({ typescript: ts }).create({
    languageService: made.ls,
    languageServiceHost: made.host,
    project: { getCurrentDirectory: () => dir, projectService: { logger: { info: (s) => void log.push(s) } } },
    config: {},
  });
  await plugin.whenReady();
  const program = created.getProgram();
  if (program === undefined) throw new Error("the language service has no program");
  const abfc = new Set();
  const tsKeys = new Set();
  let files = 0;
  for (const sf of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sf) || program.isSourceFileFromExternalLibrary(sf)) continue;
    files++;
    const rel = fwd(relative(dir, sf.fileName));
    const keyOf = (d, code) => {
      const lc = sf.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${code}|${rel}|${lc.line + 1}:${lc.character + 1}`;
    };
    for (const d of [...created.getSyntacticDiagnostics(sf.fileName), ...created.getSemanticDiagnostics(sf.fileName)]) {
      if (d.start === undefined) continue;
      if (d.source === "abfc") abfc.add(keyOf(d, `ABFC${d.code}`));
      else if (d.category === ts.DiagnosticCategory.Error || d.category === ts.DiagnosticCategory.Warning) tsKeys.add(keyOf(d, `TS${d.code}`));
    }
  }
  const disabled = log.find((l) => l.startsWith("[abfc] disabled:"));
  return { abfc, tsKeys, files, disabled };
}

function compare(label, want, got, mismatches) {
  for (const k of [...want].sort()) if (!got.has(k)) mismatches.push(`${label}: abfc check has ${k}, the plugin does not`);
  for (const k of [...got].sort()) if (!want.has(k)) mismatches.push(`${label}: the plugin has ${k}, abfc check does not`);
}

async function parity(projectArg) {
  let dir = projectArg;
  let temp = null;
  if (!existsSync(join(dir, "abf.config.json"))) {
    // a compiler fixture: copy it into the repo's node_modules so that `@abfc/runtime` resolves, and add a config
    const base = join(repo, "node_modules", ".abfc-parity");
    mkdirSync(base, { recursive: true });
    temp = mkdtempSync(join(base, "p-"));
    cpSync(dir, temp, { recursive: true });
    writeFileSync(join(temp, "abf.config.json"), JSON.stringify({ mod: { name: "TestMod" } }), "utf8");
    // `abfc check` refuses to run without a stubs lock for the profile; an empty one is enough (coverage is a warning)
    const { loadProfile } = await import("@abfc/env");
    const profile = loadProfile().id;
    mkdirSync(join(temp, ".abfc", "stubs", profile), { recursive: true });
    const lock = {
      generator: "parity",
      profile,
      engineVersion: null,
      modEditorVersion: "0",
      editorFingerprint: "",
      filterContentVersion: null,
      classes: [],
      scriptClasses: [],
      modAssets: [],
      createdAt: new Date(0).toISOString(),
    };
    writeFileSync(join(temp, ".abfc", "stubs", profile, "stubs.lock.json"), JSON.stringify(lock), "utf8");
    dir = temp;
  }
  try {
    const check = runCheck(dir);
    const lsr = await runPlugin(dir);
    const mismatches = [];
    if (lsr.disabled !== undefined) mismatches.push(`the plugin is disabled: ${lsr.disabled}`);
    compare("abfc", check.abfc, lsr.abfc, mismatches);
    compare("ts", check.tsKeys, lsr.tsKeys, mismatches);
    console.log(
      `${projectArg}: abfc check ${check.abfc.size} abfc + ${check.tsKeys.size} ts diagnostic(s) (exit ${check.exit}, ${check.skipped} out of scope); ` +
        `plugin ${lsr.abfc.size} abfc + ${lsr.tsKeys.size} ts over ${lsr.files} file(s); ${mismatches.length} mismatch(es)`,
    );
    for (const m of mismatches) console.log(`  MISMATCH ${m}`);
    return mismatches.length;
  } finally {
    if (temp !== null) rmSync(temp, { recursive: true, force: true });
  }
}

let bad = 0;
for (const p of projectsFromArgs(process.argv.slice(2))) bad += await parity(p);
console.log(bad === 0 ? "plugin-parity: OK" : `plugin-parity: ${bad} mismatch(es)`);
process.exit(bad === 0 ? 0 : 1);
