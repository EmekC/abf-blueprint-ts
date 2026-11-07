#!/usr/bin/env node
// Stages the installer input folder, writes the release zip and compiles the Inno Setup installer when ISCC is found (design 18.9).
//
//   node scripts/release/build-installer.mjs --version <semver> [--iscc <path>] [--require-iscc] [--allow-dev]
//
// --version        release version; must equal the version in build/release/exe/build-info.json
// --iscc           path of ISCC.exe (else env ABFC_ISCC, build/tools/innosetup, Program Files, per-user Programs)
// --require-iscc   exit 1 when ISCC is not found (default: skip the compile, exit 0; CI uses --require-iscc)
// --allow-dev      accept a build/release/exe made with --dev (build-info release:false); refused by default
// Requires build/release/exe (node scripts/release/build-exe.mjs) and exactly one build/vsix/abfc-vscode-*.vsix (npm run vsix).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "@abfc/env";
import { loadAllowlist, selectAllowed } from "./lib/allowlist.mjs";
import { stageRelease } from "./lib/stage.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const allowlistFile = join(repoRoot, "release", "allowlist.json");
const exeDir = join(repoRoot, "build", "release", "exe");
const vsixDir = join(repoRoot, "build", "vsix");
const inputDir = join(repoRoot, "build", "release", "installer-input");
const zipDir = join(repoRoot, "build", "release", "zip");
const installerDir = join(repoRoot, "build", "release", "installer");
const issFile = join(repoRoot, "release", "installer", "abfc.iss");
const readmeTemplate = join(repoRoot, "release", "installer", "README.txt");
const USAGE = "usage: node scripts/release/build-installer.mjs --version <semver> [--iscc <path>] [--require-iscc] [--allow-dev]";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`build-installer: ${message}`);
  process.exit(1);
}

function parseArgv(argv) {
  const o = { version: "", iscc: "", requireIscc: false, allowDev: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") o.version = String(argv[++i] ?? "");
    else if (a === "--iscc") o.iscc = String(argv[++i] ?? "");
    else if (a === "--require-iscc") o.requireIscc = true;
    else if (a === "--allow-dev") o.allowDev = true;
    else fail(`unknown argument ${a}\n${USAGE}`);
  }
  if (!SEMVER.test(o.version)) fail(`--version must be a semver like 1.0.0 or 1.0.0-rc.0\n${USAGE}`);
  return o;
}

/** ISCC lookup order: --iscc, ABFC_ISCC, build/tools/innosetup, Program Files (x86), per-user Programs. First existing file wins. */
function findIscc(flag) {
  const candidates = [];
  if (flag !== "") candidates.push(resolve(flag));
  if ((process.env.ABFC_ISCC ?? "") !== "") candidates.push(resolve(process.env.ABFC_ISCC));
  candidates.push(join(repoRoot, "build", "tools", "innosetup", "ISCC.exe"));
  const pf86 = process.env["ProgramFiles(x86)"];
  if (pf86) candidates.push(join(pf86, "Inno Setup 6", "ISCC.exe"));
  const local = process.env.LOCALAPPDATA;
  if (local) candidates.push(join(local, "Programs", "Inno Setup 6", "ISCC.exe"));
  return candidates.find((c) => existsSync(c)) ?? "";
}

function main() {
  const o = parseArgv(process.argv.slice(2));

  const infoFile = join(exeDir, "build-info.json");
  const exe = join(exeDir, "abfc.exe");
  const notices = join(exeDir, "THIRD-PARTY-NOTICES.txt");
  for (const f of [infoFile, exe, notices]) {
    if (!existsSync(f)) fail(`${f} is missing: run node scripts/release/build-exe.mjs first`);
  }
  const info = JSON.parse(readFileSync(infoFile, "utf8"));
  if (info.version !== o.version) fail(`--version ${o.version} differs from build/release/exe/build-info.json (${info.version}): rebuild the exe with that version`);
  if (info.release !== true) {
    if (o.allowDev) console.warn("build-installer: --allow-dev: build-info.json is a --dev build");
    else fail("build/release/exe/build-info.json is a --dev build (release is not true): rebuild the exe without --dev, or pass --allow-dev");
  }

  const vsixes = existsSync(vsixDir) ? readdirSync(vsixDir).filter((n) => /^abfc-vscode-.+\.vsix$/.test(n)) : [];
  if (vsixes.length !== 1) fail(`expected exactly one build/vsix/abfc-vscode-*.vsix, found ${vsixes.length}: run npm run vsix (and remove stale files)`);
  const vsix = join(vsixDir, vsixes[0]);

  // stage the installer input folder
  const names = stageRelease({ exe, vsix, notices, licenseFile: join(repoRoot, "LICENSE"), readmeTemplate, version: o.version, outDir: inputDir });
  const allow = loadAllowlist(allowlistFile);
  for (const kind of ["installer", "zip"]) {
    const sel = selectAllowed(names, allow[kind]);
    if (sel.rejected.length > 0) fail(`files not on the ${kind} allowlist: ${sel.rejected.join(", ")}`);
    if (sel.unmatchedPatterns.length > 0) fail(`${kind} allowlist entries without a file: ${sel.unmatchedPatterns.join(", ")}`);
  }
  console.log(`staged ${names.length} files in build/release/installer-input: ${names.join(", ")}`);

  // zip: names at the root, sorted, deterministic
  rmSync(zipDir, { recursive: true, force: true });
  mkdirSync(zipDir, { recursive: true });
  const zipFile = join(zipDir, `abfc-${o.version}-win-x64.zip`);
  const zip = writeZip(names.map((name) => ({ name, data: readFileSync(join(inputDir, name)) })));
  writeFileSync(zipFile, zip);
  console.log(`zip: build/release/zip/${basename(zipFile)} (${zip.length} bytes)`);

  // installer
  const iscc = findIscc(o.iscc);
  if (iscc === "") {
    console.log("ISCC not found: compile skipped (input staged in build/release/installer-input)");
    if (o.requireIscc) fail("--require-iscc given but ISCC.exe was not found");
    return;
  }
  rmSync(installerDir, { recursive: true, force: true });
  mkdirSync(installerDir, { recursive: true });
  const args = [
    `/DAppVersion=${o.version}`,
    `/DInputDir=${inputDir}`,
    `/DOutputDir=${installerDir}`,
    `/DVsixName=${vsixes[0]}`,
    `/DLicenseFile=${join(inputDir, "LICENSE.txt")}`,
    issFile,
  ];
  console.log(`ISCC: ${iscc}`);
  const r = spawnSync(iscc, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  if (r.error) fail(`could not start ISCC: ${r.error.message}`);
  if (r.status !== 0) fail(`ISCC exited with ${r.status}`);
  const compressed = new Set([...out.matchAll(/Compressing:\s+(.+)/g)].map((m) => basename(m[1].trim()).toLowerCase()));
  const missing = names.filter((n) => !compressed.has(n.toLowerCase()));
  if (missing.length > 0) fail(`ISCC output has no "Compressing:" line for: ${missing.join(", ")}`);
  const setup = join(installerDir, `abfc-setup-${o.version}.exe`);
  if (!existsSync(setup)) fail(`${setup} was not created`);
  console.log(`installer: build/release/installer/${basename(setup)} (${statSync(setup).size} bytes)`);
}

main();
