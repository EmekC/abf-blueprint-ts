#!/usr/bin/env node
// Parity check: `abfc lsp` must publish the diagnostics the compiler reports for a project.
//
//   node scripts/lsp-parity.mjs --project <dir> [--project <dir> ...]
//
// Per project it computes the reference in-process (the compiler's loadProgram + checkProject with the environment helper
// the server uses; `abfc check` is never run, so nothing is written into the project), starts `abfc lsp --stdio` as a
// child process, opens every source file of the program that is neither a default library nor an external library
// (text read from disk) and compares per file
//   (a) the abfc diagnostics (every code except ABFC2000 and the lock codes, with a span) by (code, file, line, col) and
//   (b) the TypeScript diagnostics (ABFC2000 "[TSnnnn]" with a span; the server runs with tsDiagnostics) by (TS code, file, line, col).
// Lint findings (codes `abfc/<rule>`) are counted and printed, not compared. Prints the counts and every mismatch; exits 1
// on any mismatch, 2 on a usage error or a missing build. The project is only read: a project without an abf.config.json
// (the compiler test fixtures) is compared through a temporary copy with a config added.
// Requires `npm run build`.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lspPath = join(repo, "packages", "lsp", "dist", "src", "index.js");
const binPath = join(repo, "packages", "cli", "dist", "src", "bin.js");
if (!existsSync(lspPath) || !existsSync(binPath)) {
  console.error("lsp-parity: run `npm run build` first");
  process.exit(2);
}
const { StdioLspClient, compilerConfigOf, loadProjectEnvironment } = await import(pathToFileURL(lspPath).href);
const { checkProject, loadProgram } = await import("@abfc/compiler");

const USAGE = "usage: node scripts/lsp-parity.mjs [--abfc <abfc.exe>] --project <dir> [--project <dir> ...]";
// --abfc <exe>: start `<exe> lsp --stdio` instead of `node bin.js lsp --stdio` (checks the built single executable).
let abfcExe = null;
const OVERALL_MS = 180_000;
const QUIET_MS = 1_000;

const fwd = (p) => p.replaceAll("\\", "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function projectsFromArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && argv[i + 1] !== undefined) out.push(resolve(argv[++i]));
    else if (argv[i] === "--abfc" && argv[i + 1] !== undefined) abfcExe = resolve(argv[++i]);
    else {
      console.error(`lsp-parity: unexpected argument ${argv[i]}\n${USAGE}`);
      process.exit(2);
    }
  }
  if (out.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  return out;
}

/** The source files of a loaded program that belong to the project, as absolute paths. */
function projectFiles(dir, program) {
  const files = [];
  for (const sf of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(sf) || program.isSourceFileFromExternalLibrary(sf)) continue;
    const rel = fwd(relative(dir, sf.fileName));
    if (rel.startsWith("../") || rel === ".." || /^[A-Za-z]:/.test(rel)) continue;
    files.push(sf.fileName);
  }
  return files;
}

/** What the compiler reports (read-only, in-process): abfc keys and TS keys over the given files. */
function reference(dir) {
  const env = loadProjectEnvironment(dir);
  const loaded = loadProgram(dir);
  const check = checkProject(loaded, compilerConfigOf(env.config), env.profile);
  const files = projectFiles(dir, loaded.program);
  const rels = new Set(files.map((f) => fwd(relative(dir, f))));
  const abfc = new Set();
  const tsKeys = new Set();
  for (const d of check.diagnostics) {
    if (d.code === "ABFC2000" || d.span === undefined || !rels.has(d.span.file)) continue;
    abfc.add(`${d.code}|${d.span.file}|${d.span.line}:${d.span.col}`);
  }
  for (const d of loaded.diagnostics) {
    if (d.code !== "ABFC2000" || d.span === undefined || !rels.has(d.span.file)) continue;
    const m = /^\[TS(\d+)\]/.exec(d.message);
    if (m !== null) tsKeys.add(`TS${m[1]}|${d.span.file}|${d.span.line}:${d.span.col}`);
  }
  return { abfc, tsKeys, files };
}

/** What `abfc lsp --stdio` publishes for the opened files. */
async function viaLsp(dir, files) {
  const [command, args] = abfcExe === null ? [process.execPath, [binPath, "lsp", "--stdio"]] : [abfcExe, ["lsp", "--stdio"]];
  const child = spawn(command, args, { cwd: dir, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
  const exited = new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
  const client = new StdioLspClient(child.stdout, child.stdin);
  const latest = new Map();
  let lastPublish = Date.now();
  client.onNotification("textDocument/publishDiagnostics", (p) => {
    latest.set(p.uri, p.diagnostics);
    lastPublish = Date.now();
  });
  const uriOf = new Map(files.map((f) => [pathToFileURL(f).href, f]));
  try {
    await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      capabilities: {},
      initializationOptions: { tsDiagnostics: true, debounceMs: 0 },
    });
    client.notify("initialized", {});
    for (const [uri, file] of uriOf) {
      client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: readFileSync(file, "utf8") } });
    }
    const start = Date.now();
    for (;;) {
      const missing = [...uriOf.keys()].filter((u) => !latest.has(u));
      if (missing.length === 0 && Date.now() - lastPublish >= QUIET_MS) break;
      if (Date.now() - start > OVERALL_MS) throw new Error(`no diagnostics for ${missing.length} of ${uriOf.size} file(s) within ${OVERALL_MS / 1000} s (e.g. ${missing[0]})`);
      await sleep(100);
    }
    const abfc = new Set();
    const tsKeys = new Set();
    let lint = 0;
    for (const [uri, file] of uriOf) {
      const rel = fwd(relative(dir, file));
      for (const d of latest.get(uri) ?? []) {
        const code = String(d.code);
        const at = `${rel}|${d.range.start.line + 1}:${d.range.start.character + 1}`;
        if (code.startsWith("abfc/")) lint++;
        else if (code === "ABFC2000") {
          const m = /^\[TS(\d+)\]/.exec(d.message);
          if (m !== null) tsKeys.add(`TS${m[1]}|${at}`);
        } else if (code.startsWith("ABFC")) abfc.add(`${code}|${at}`);
      }
    }
    await client.request("shutdown", null, 20_000);
    client.notify("exit", null);
    const code = await Promise.race([exited, sleep(20_000).then(() => "timeout")]);
    if (code !== 0) throw new Error(`abfc lsp exited with ${code} (stderr: ${stderr.slice(0, 400)})`);
    if (client.protocolErrors.length > 0) throw new Error(`stdout carried non-protocol data: ${JSON.stringify(client.protocolErrors.slice(0, 3))}`);
    return { abfc, tsKeys, lint };
  } finally {
    client.close();
    child.kill();
  }
}

function compare(label, want, got, mismatches) {
  for (const k of [...want].sort()) if (!got.has(k)) mismatches.push(`${label}: the compiler reports ${k}, abfc lsp does not`);
  for (const k of [...got].sort()) if (!want.has(k)) mismatches.push(`${label}: abfc lsp reports ${k}, the compiler does not`);
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
    writeFileSync(join(temp, "abf.config.json"), JSON.stringify({ schemaVersion: 2, mod: { name: "TestMod" } }), "utf8");
    dir = temp;
  }
  try {
    const ref = reference(dir);
    const got = await viaLsp(dir, ref.files);
    const mismatches = [];
    compare("abfc", ref.abfc, got.abfc, mismatches);
    compare("ts", ref.tsKeys, got.tsKeys, mismatches);
    console.log(
      `${projectArg}: reference ${ref.abfc.size} abfc + ${ref.tsKeys.size} ts; lsp ${got.abfc.size} abfc + ${got.tsKeys.size} ts over ${ref.files.length} file(s), ${got.lint} lint finding(s); ${mismatches.length} mismatch(es)`,
    );
    for (const m of mismatches) console.log(`  MISMATCH ${m}`);
    return mismatches.length;
  } finally {
    if (temp !== null) rmSync(temp, { recursive: true, force: true });
  }
}

let bad = 0;
for (const p of projectsFromArgs(process.argv.slice(2))) bad += await parity(p);
console.log(bad === 0 ? "lsp-parity: OK" : `lsp-parity: ${bad} mismatch(es)`);
process.exit(bad === 0 ? 0 : 1);
