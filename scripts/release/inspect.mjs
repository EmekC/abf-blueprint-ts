#!/usr/bin/env node
// Checks the built release artifacts against each other and the allowlists (design 18.9, 18.10).
//
//   node scripts/release/inspect.mjs --version <semver> [--allow-dev]
//
// - the release zip holds exactly the files of build/release/installer-input (names, sizes, sha256) and passes allowlist.zip
// - runtime.zip holds exactly the files of runtime.sha256.json (size + sha256), matches its recorded zip sha256 and passes allowlist.runtime
// - abfc.exe in the zip has the sha256 recorded in build-info.json
// - build-info.json is a release build (release:true); --allow-dev accepts a --dev build
// - no user paths in the shipped text files, and no user path or .claude folder in any binary (abfc.exe and every other zip entry, every runtime.zip entry; scanned after decompression) as latin1 or UTF-16LE
// - the installer exe, when present, is between 20 MB and 250 MB
// Exit 1 on any mismatch.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip } from "@abfc/env";
import { loadAllowlist, selectAllowed } from "./lib/allowlist.mjs";
import { sha256Buf } from "./lib/pins.mjs";
import { checkNoBuildPathsInBinary, checkNoUserPaths } from "./lib/runtime.mjs";
import { listingOf } from "./lib/stage.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = "usage: node scripts/release/inspect.mjs --version <semver> [--allow-dev]";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const MB = 1024 * 1024;

const problems = [];
const bad = (message) => problems.push(message);
const mb = (n) => `${(n / MB).toFixed(2)} MB`;

function parseArgv(argv) {
  let version = "";
  let allowDev = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version") version = String(argv[++i] ?? "");
    else if (argv[i] === "--allow-dev") allowDev = true;
    else {
      console.error(`inspect: unknown argument ${argv[i]}\n${USAGE}`);
      process.exit(1);
    }
  }
  if (!SEMVER.test(version)) {
    console.error(`inspect: --version must be a semver like 1.0.0 or 1.0.0-rc.0\n${USAGE}`);
    process.exit(1);
  }
  return { version, allowDev };
}

function need(file) {
  if (existsSync(file)) return true;
  bad(`missing ${file}`);
  return false;
}

function checkAllowlist(kind, names, patterns) {
  const sel = selectAllowed(names, patterns);
  for (const n of sel.rejected) bad(`${kind}: ${n} is not on the allowlist`);
  for (const p of sel.unmatchedPatterns) bad(`${kind}: allowlist entry ${p} matches no file`);
}

function main() {
  const { version, allowDev } = parseArgv(process.argv.slice(2));
  const allow = loadAllowlist(join(repoRoot, "release", "allowlist.json"));
  const exeInfoFile = join(repoRoot, "build", "release", "exe", "build-info.json");
  const inputDir = join(repoRoot, "build", "release", "installer-input");
  const zipFile = join(repoRoot, "build", "release", "zip", `abfc-${version}-win-x64.zip`);
  const runtimeZipFile = join(repoRoot, "build", "release", "runtime", "runtime.zip");
  const runtimeManifestFile = join(repoRoot, "build", "release", "runtime", "runtime.sha256.json");
  const setupFile = join(repoRoot, "build", "release", "installer", `abfc-setup-${version}.exe`);
  const rows = [];

  if (![exeInfoFile, zipFile, runtimeZipFile, runtimeManifestFile].every(need) || !need(inputDir)) {
    report(rows, version);
    return;
  }
  const info = JSON.parse(readFileSync(exeInfoFile, "utf8"));
  if (info.version !== version) bad(`build-info.json is for ${info.version}, not ${version}`);
  if (info.release !== true) {
    if (allowDev) console.warn("inspect: --allow-dev: build-info.json is a --dev build");
    else bad("build-info.json is a --dev build (release is not true); rebuild without --dev, or pass --allow-dev");
  }

  // release zip vs installer input folder
  const listing = listingOf(inputDir);
  const zipBuf = readFileSync(zipFile);
  const zipEntries = readZip(zipBuf);
  const byName = new Map(zipEntries.map((e) => [e.name, e]));
  for (const l of listing) {
    const e = byName.get(l.name);
    if (e === undefined) {
      bad(`zip: ${l.name} is missing`);
      continue;
    }
    const data = e.read();
    const sha = sha256Buf(data);
    if (data.length !== l.size) bad(`zip: ${l.name} is ${data.length} bytes, installer-input has ${l.size}`);
    if (sha !== l.sha256) bad(`zip: ${l.name} sha256 differs from installer-input`);
    if (l.name === "abfc.exe" && sha !== info.exeSha256) bad(`zip: abfc.exe sha256 ${sha} differs from build-info exeSha256 ${info.exeSha256}`);
    try {
      checkNoUserPaths(l.name, data);
      checkNoBuildPathsInBinary(l.name, data);
    } catch (err) {
      bad(`zip: ${err.message}`);
    }
    rows.push(["zip", l.name, data.length, sha]);
  }
  for (const e of zipEntries) if (!listing.some((l) => l.name === e.name)) bad(`zip: ${e.name} is not in installer-input`);
  checkAllowlist("zip", zipEntries.map((e) => e.name), allow.zip);
  checkAllowlist("installer", listing.map((l) => l.name), allow.installer);

  // runtime.zip vs its manifest
  const rtBuf = readFileSync(runtimeZipFile);
  const manifest = JSON.parse(readFileSync(runtimeManifestFile, "utf8"));
  const rtSha = sha256Buf(rtBuf);
  if (rtSha !== manifest.zipSha256) bad(`runtime.zip sha256 ${rtSha} differs from runtime.sha256.json zipSha256`);
  if (rtSha !== info.runtimeZipSha256) bad(`runtime.zip sha256 differs from build-info runtimeZipSha256`);
  if (manifest.abfcVersion !== version) bad(`runtime.sha256.json is for ${manifest.abfcVersion}, not ${version}`);
  const rtEntries = readZip(rtBuf);
  const rtByName = new Map(rtEntries.map((e) => [e.name, e]));
  const manifestNames = Object.keys(manifest.files);
  let rtBytes = 0;
  for (const name of manifestNames) {
    const e = rtByName.get(name);
    if (e === undefined) {
      bad(`runtime.zip: ${name} is missing`);
      continue;
    }
    const data = e.read();
    rtBytes += data.length;
    if (data.length !== manifest.files[name].size) bad(`runtime.zip: ${name} is ${data.length} bytes, manifest says ${manifest.files[name].size}`);
    if (sha256Buf(data) !== manifest.files[name].sha256) bad(`runtime.zip: ${name} sha256 differs from the manifest`);
    try {
      checkNoUserPaths(name, data);
      checkNoBuildPathsInBinary(name, data);
    } catch (err) {
      bad(`runtime.zip: ${err.message}`);
    }
  }
  for (const e of rtEntries) if (!(e.name in manifest.files)) bad(`runtime.zip: ${e.name} is not in the manifest`);
  checkAllowlist("runtime", rtEntries.map((e) => e.name), allow.runtime);
  rows.push(["runtime.zip", `${rtEntries.length} files (${mb(rtBytes)} unpacked)`, rtBuf.length, rtSha]);

  // installer exe (optional)
  if (existsSync(setupFile)) {
    const size = statSync(setupFile).size;
    if (size < 20 * MB || size > 250 * MB) bad(`installer: ${size} bytes is outside 20 MB .. 250 MB`);
    rows.push(["installer", `abfc-setup-${version}.exe`, size, ""]);
  } else {
    console.log("installer exe not built (ISCC step skipped): not checked");
  }
  rows.push(["zip", `abfc-${version}-win-x64.zip`, zipBuf.length, sha256Buf(zipBuf)]);
  report(rows, version);
}

function report(rows, version) {
  console.log(`inspect abfc ${version}`);
  for (const [kind, name, size, sha] of rows) {
    console.log(`  ${kind.padEnd(11)} ${String(name).padEnd(34)} ${String(size).padStart(11)} B  ${sha === "" ? "" : sha.slice(0, 16)}`);
  }
  const total = rows.filter((r) => r[0] === "zip" && r[1].endsWith(".zip")).reduce((a, r) => a + r[2], 0);
  if (total > 0) console.log(`  zip total ${mb(total)}`);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  PROBLEM: ${p}`);
    console.error(`inspect: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("inspect: ok");
}

main();
