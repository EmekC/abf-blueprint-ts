#!/usr/bin/env node
// Stages the files of a GitHub release into build/release/github/ (design 18.10).
//
//   node scripts/release/stage-github.mjs --version <semver> [--require-installer]
//
// Copies the exe, the zip, the installer (required with --require-installer, otherwise skipped when missing) and the
// .vsix, then writes SHA256SUMS.txt and release-notes.md (the CHANGELOG section of the version).
// Exit 0 on success, 1 on a missing input, 2 on a usage error.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSection, sumsText } from "./lib/github.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = "usage: node scripts/release/stage-github.mjs --version <semver> [--require-installer]";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function fail(message, code = 1) {
  console.error(`stage-github: ${message}`);
  process.exit(code);
}

const o = { version: "", requireInstaller: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--version") {
    const v = argv[++i];
    if (v === undefined) fail(`--version needs a value\n${USAGE}`, 2);
    o.version = v;
  } else if (a === "--require-installer") o.requireInstaller = true;
  else fail(`unknown argument ${a}\n${USAGE}`, 2);
}
if (!SEMVER.test(o.version)) fail(`--version must be a semver like 1.0.0 or 1.0.0-rc.0\n${USAGE}`, 2);

const v = o.version;
const inputs = [
  { from: join(repoRoot, "build", "release", "exe", "abfc.exe"), name: `abfc-${v}-win-x64.exe`, required: true },
  { from: join(repoRoot, "build", "release", "zip", `abfc-${v}-win-x64.zip`), name: `abfc-${v}-win-x64.zip`, required: true },
  {
    from: join(repoRoot, "build", "release", "installer", `abfc-setup-${v}.exe`),
    name: `abfc-setup-${v}.exe`,
    required: o.requireInstaller,
  },
  { from: join(repoRoot, "build", "vsix", `abfc-vscode-${v}.vsix`), name: `abfc-vscode-${v}.vsix`, required: true },
];

let notes;
try {
  notes = changelogSection(readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8"), v);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const missing = inputs.filter((f) => f.required && !existsSync(f.from));
if (missing.length > 0) fail(`missing input: ${missing.map((f) => f.from).join(", ")}`);

const out = join(repoRoot, "build", "release", "github");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const sums = [];
for (const f of inputs) {
  if (!existsSync(f.from)) {
    console.log(`skipped ${f.name}: not built (no Inno Setup compiler locally)`);
    continue;
  }
  const dest = join(out, f.name);
  copyFileSync(f.from, dest);
  const sha256 = createHash("sha256").update(readFileSync(dest)).digest("hex");
  sums.push({ name: f.name, sha256 });
  console.log(`staged ${f.name}  ${sha256}`);
}
writeFileSync(join(out, "SHA256SUMS.txt"), sumsText(sums), "utf8");
writeFileSync(
  join(out, "release-notes.md"),
  `${notes}\n\nVerify downloads with SHA256SUMS.txt; the files are not code-signed (see docs/install.md).\n`,
  "utf8",
);
console.log(`wrote SHA256SUMS.txt and release-notes.md; ${readdirSync(out).length} files in ${out}`);
