#!/usr/bin/env node
// Downloads the pinned release inputs into build/cache/ and verifies / records their sha256 in release/pins.json.
//
//   node scripts/release/fetch-pins.mjs [--download] [--record] [--only <list>] [--innosetup-version <x.y.z>]
//
// Without --download nothing is fetched over the network: cached files are only verified, a missing file is an error.
// --download   fetch missing files (needs the user's approval, see the phase plan)
// --record     accept the hash of a file whose pin is still empty and write it into release/pins.json
// --only       comma list of: node-shasums, node-license, node-exe, python, innosetup
//              (default: node-shasums,node-license,python)
// --innosetup-version <x.y.z>   fills innosetup.version and innosetup.url when they are empty
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPinned, loadPins, parseShasums, savePins, sha256File } from "./lib/pins.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pinsFile = join(repoRoot, "release", "pins.json");
const cacheDir = join(repoRoot, "build", "cache");
const ALL = ["node-shasums", "node-license", "node-exe", "python", "innosetup"];

function parseArgv(argv) {
  const o = { download: false, record: false, only: ["node-shasums", "node-license", "python"], innosetupVersion: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--download") o.download = true;
    else if (a === "--record") o.record = true;
    else if (a === "--only") o.only = String(argv[++i] ?? "").split(",").filter((s) => s !== "");
    else if (a === "--innosetup-version") o.innosetupVersion = String(argv[++i] ?? "");
    else throw new Error(`unknown argument ${a}`);
  }
  for (const s of o.only) if (!ALL.includes(s)) throw new Error(`unknown --only item ${s} (known: ${ALL.join(", ")})`);
  return o;
}

async function main() {
  const o = parseArgv(process.argv.slice(2));
  const pins = loadPins(pinsFile);
  let changed = false;
  const rows = [];
  const want = (id) => o.only.includes(id);
  const row = (id, r) => rows.push({ id, path: r.path, size: statSync(r.path).size, sha256: r.sha256, recorded: r.recorded });

  if (o.innosetupVersion !== "" && pins.innosetup.version === "") {
    pins.innosetup.version = o.innosetupVersion;
    pins.innosetup.url = `https://files.jrsoftware.org/is/6/innosetup-${o.innosetupVersion}.exe`;
    changed = true;
  }

  const nodeV = pins.node.version;
  if (want("node-shasums")) {
    const dest = join(cacheDir, `node-v${nodeV}-SHASUMS256.txt`);
    // The checksum list is the trust anchor (TLS); it is not hash-pinned itself.
    const pin = { url: pins.node.shasumsUrl, sha256: existsSync(dest) ? sha256File(dest) : "" };
    const r = await fetchPinned(pin, dest, { download: o.download, record: true, what: "node SHASUMS256.txt" });
    row("node-shasums", { ...r, recorded: false });
    const expected = parseShasums(readFileSync(dest, "utf8"), "win-x64/node.exe");
    if (expected === null) throw new Error("SHASUMS256.txt has no win-x64/node.exe line");
    if (pins.node.sha256 === "") {
      if (!o.record) throw new Error("pin node.sha256 is empty: run node scripts/release/fetch-pins.mjs --record (needs approval)");
      pins.node.sha256 = expected;
      changed = true;
    } else if (pins.node.sha256 !== expected) {
      throw new Error(`node.sha256 pin (${pins.node.sha256}) differs from SHASUMS256.txt (${expected})`);
    }
    if (process.version === `v${nodeV}`) {
      const local = sha256File(process.execPath);
      console.log(
        local === pins.node.sha256
          ? "local node.exe matches the pinned official build"
          : "local node.exe differs: approval A4 (download node.exe) needed",
      );
    }
  }
  if (want("node-license")) {
    const dest = join(cacheDir, `node-v${nodeV}-LICENSE.txt`);
    const r = await fetchPinned({ url: pins.node.licenseUrl, sha256: pins.node.licenseSha256 }, dest, {
      download: o.download,
      record: o.record,
      what: "node.licenseSha256",
    });
    if (r.recorded) {
      pins.node.licenseSha256 = r.sha256;
      changed = true;
    }
    row("node-license", r);
  }
  if (want("node-exe")) {
    if (pins.node.sha256 === "") throw new Error("pin node.sha256 is empty: fetch node-shasums first (needs approval)");
    const dest = join(cacheDir, `node-v${nodeV}-win-x64.exe`);
    row("node-exe", await fetchPinned({ url: pins.node.url, sha256: pins.node.sha256 }, dest, {
      download: o.download,
      record: false,
      what: "node.exe",
    }));
  }
  if (want("python")) {
    const dest = join(cacheDir, `python-${pins.python.version}-embed-amd64.zip`);
    const r = await fetchPinned({ url: pins.python.url, sha256: pins.python.sha256 }, dest, {
      download: o.download,
      record: o.record,
      what: "python.sha256",
    });
    if (r.recorded) {
      pins.python.sha256 = r.sha256;
      changed = true;
    }
    row("python", r);
  }
  if (want("innosetup")) {
    if (pins.innosetup.url === "") throw new Error("innosetup.url is empty: pass --innosetup-version <x.y.z> (needs approval)");
    const dest = join(cacheDir, `innosetup-${pins.innosetup.version}.exe`);
    const r = await fetchPinned({ url: pins.innosetup.url, sha256: pins.innosetup.sha256 }, dest, {
      download: o.download,
      record: o.record,
      what: "innosetup.sha256",
    });
    if (r.recorded) {
      pins.innosetup.sha256 = r.sha256;
      changed = true;
    }
    row("innosetup", r);
  }

  if (changed) savePins(pinsFile, pins);
  for (const r of rows) {
    console.log(`${r.id.padEnd(13)} ${String(r.size).padStart(10)}  ${r.sha256}  ${r.recorded ? "recorded" : "verified"}  ${r.path}`);
  }
}

main().catch((e) => {
  console.error(`fetch-pins: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
