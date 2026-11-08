#!/usr/bin/env node
// Scans the built release artifacts for mod names, user and build paths, dev folders and game-derived files (design 18.10).
//
//   node scripts/release/scan-artifacts.mjs --version <semver> [--denylist <file>]
//                                           [--require <list>] [--repo-root <dir>]
//
// Artifacts (kind: location): exe: build/release/exe/abfc.exe, runtime: build/release/runtime/runtime.zip,
// zip: build/release/zip/abfc-<v>-win-x64.zip, installer-input: every file of build/release/installer-input,
// installer: build/release/installer/abfc-setup-<v>.exe, vsix: build/vsix/abfc-vscode-<v>.vsix,
// npm: build/release/npm/*.tgz.
// Names: the committed guard words plus `--denylist <file>` (a file outside the repository) (an optional local
// file outside the repository, one name per line); name hits are printed as `guard word #i` / `denylist entry #i`, never as the word.
// Exit 0 clean, 1 on hits, 2 on a usage error, or a missing required artifact.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_WORDS, applyExceptions, loadExceptions, parseDenylist, scanArtifact } from "./lib/scan.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE =
  "usage: node scripts/release/scan-artifacts.mjs --version <semver> [--denylist <file>] [--require <list>] [--repo-root <dir>]";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const KINDS = ["exe", "runtime", "zip", "installer-input", "installer", "vsix", "npm"];
const DEFAULT_REQUIRE = "exe,runtime,zip,installer-input,vsix,npm";

function fail(message, code = 2) {
  console.error(`scan-artifacts: ${message}`);
  process.exit(code);
}

function parseArgv(argv) {
  const o = { version: "", denylist: "", require: DEFAULT_REQUIRE, repoRoot: defaultRoot };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "--version") o.version = value();
    else if (a === "--denylist") o.denylist = value();
    else if (a === "--require") o.require = value();
    else if (a === "--repo-root") o.repoRoot = resolve(value());
    else fail(`unknown argument ${a}\n${USAGE}`);
  }
  if (!SEMVER.test(o.version)) fail(`--version must be a semver like 1.0.0 or 1.0.0-rc.0\n${USAGE}`);
  o.require = o.require.split(",").map((s) => s.trim()).filter((s) => s !== "");
  for (const k of o.require) if (!KINDS.includes(k)) fail(`--require: unknown artifact "${k}" (known: ${KINDS.join(", ")})\n${USAGE}`);
  return o;
}

function filesUnder(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else if (e.isFile()) out.push({ file: join(d, e.name), name: `${rel}${e.name}` });
    }
  };
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir, "");
  return out;
}

function single(file) {
  return existsSync(file) && statSync(file).isFile() ? [{ file, name: basename(file) }] : [];
}

function locate(root, v) {
  const b = join(root, "build");
  return {
    exe: single(join(b, "release", "exe", "abfc.exe")),
    runtime: single(join(b, "release", "runtime", "runtime.zip")),
    zip: single(join(b, "release", "zip", `abfc-${v}-win-x64.zip`)),
    "installer-input": filesUnder(join(b, "release", "installer-input")),
    installer: single(join(b, "release", "installer", `abfc-setup-${v}.exe`)),
    vsix: single(join(b, "vsix", `abfc-vscode-${v}.vsix`)),
    npm: filesUnder(join(b, "release", "npm")).filter((f) => f.name.endsWith(".tgz")),
  };
}

const o = parseArgv(process.argv.slice(2));

const names = GUARD_WORDS.map((word, i) => ({ word, label: `guard word #${i + 1}` }));
let denylistWords = null;
try {
  if (o.denylist !== "") {
    if (!existsSync(o.denylist)) fail("--denylist file not found");
    denylistWords = parseDenylist(readFileSync(o.denylist, "utf8"));
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
if (denylistWords !== null && denylistWords.length === 0) denylistWords = null;
if (denylistWords === null) {
  console.log("notice: no name denylist given; scanning with the committed guard words only");
} else {
  denylistWords.forEach((word, i) => names.push({ word, label: `denylist entry #${i + 1}` }));
}

const exceptionsFile = join(o.repoRoot, "release", "scan-exceptions.json");
let exceptions = [];
try {
  if (existsSync(exceptionsFile)) exceptions = loadExceptions(exceptionsFile);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const found = locate(o.repoRoot, o.version);
const missing = [];
const scanned = [];
for (const kind of KINDS) {
  if (found[kind].length > 0) scanned.push(kind);
  else if (o.require.includes(kind)) missing.push(kind);
  else console.log(`not scanned: ${kind} (not built)`);
}
if (missing.length > 0) fail(`required artifact not found: ${missing.join(", ")} (build it first)`);

const stats = { entries: 0, bytes: 0 };
const ctx = { names, repoRoot: o.repoRoot, stats };
const hits = [];
const stable = (name) => name.split(o.version).join("<version>");
for (const kind of scanned) {
  for (const f of found[kind]) {
    hits.push(...scanArtifact({ artifact: kind, name: stable(f.name), buf: readFileSync(f.file), ctx }));
  }
  console.log(`scanned ${kind}: ${found[kind].length} file(s)`);
}

const { failing, excepted, unused } = applyExceptions(hits, exceptions);
const line = (prefix, h) => `${prefix} ${h.rule} ${h.artifact} > ${h.entry}: ${h.detail} [context ${h.context.slice(0, 12)}]`;
for (const h of failing) console.log(line("HIT", h));
for (const h of excepted) console.log(line("EXCEPTED", h));
for (const e of unused) {
  if (scanned.includes(e.artifact)) console.log(`warning: unused scan exception ${e.rule} ${e.artifact} > ${e.entry} [context ${e.context.slice(0, 12)}]`);
}
console.log(
  `summary: ${scanned.length} artifact kind(s), ${stats.entries} entries, ${(stats.bytes / (1024 * 1024)).toFixed(1)} MB scanned; ${failing.length} hit(s), ${excepted.length} excepted`,
);
process.exit(failing.length > 0 ? 1 : 0);
