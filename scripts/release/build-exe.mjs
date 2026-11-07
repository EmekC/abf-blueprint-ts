#!/usr/bin/env node
// Builds build/release/exe/abfc.exe (Node single executable application) with the bundled runtime (design 18.8).
//
//   node scripts/release/build-exe.mjs --version <semver> --backend-repo <dir> [--node-exe <path>] [--dev] [--record]
//
// --version       release version, e.g. 1.0.0-rc.0 (required)
// --backend-repo  local git checkout of the backend (else env ABFC_BACKEND_REPO); only read through git rev-parse/ls-tree/cat-file
// --node-exe      the node.exe that builds and hosts the SEA (default: build/cache copy, else the running node when it is the pinned version)
// --dev           allow a node.exe that differs from the pin and an empty backend.filesSha256 (build-info release:false)
// --record        write an empty backend.filesSha256 into release/pins.json
// Requires `npm run build` and the cached, pinned downloads (node scripts/release/fetch-pins.mjs).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadAllowlist, selectAllowed } from "./lib/allowlist.mjs";
import { vendorBackend } from "./lib/backend.mjs";
import { packageDirsFromMetafile, noticesText } from "./lib/notices.mjs";
import { stripAuthenticode } from "./lib/pe.mjs";
import { loadPins, savePins, sha256Buf, sha256File } from "./lib/pins.mjs";
import { embedPythonFiles } from "./lib/python.mjs";
import { buildRuntimeZip, checkNoBuildPathsInBinary, checkNoUserPaths, collectRuntimeFiles } from "./lib/runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pinsFile = join(repoRoot, "release", "pins.json");
const allowlistFile = join(repoRoot, "release", "allowlist.json");
const cacheDir = join(repoRoot, "build", "cache");
const workDir = join(repoRoot, "build", "release", "work");
const runtimeOut = join(repoRoot, "build", "release", "runtime");
const exeOut = join(repoRoot, "build", "release", "exe");
const USAGE = "usage: node scripts/release/build-exe.mjs --version <semver> --backend-repo <dir> [--node-exe <path>] [--dev] [--record]";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function fail(message) {
  console.error(`build-exe: ${message}`);
  process.exit(1);
}

function parseArgv(argv) {
  const o = { version: "", backendRepo: process.env.ABFC_BACKEND_REPO ?? "", nodeExe: "", dev: false, record: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") o.version = String(argv[++i] ?? "");
    else if (a === "--backend-repo") o.backendRepo = String(argv[++i] ?? "");
    else if (a === "--node-exe") o.nodeExe = String(argv[++i] ?? "");
    else if (a === "--dev") o.dev = true;
    else if (a === "--record") o.record = true;
    else fail(`unknown argument ${a}\n${USAGE}`);
  }
  if (!SEMVER.test(o.version)) fail(`--version must be a semver like 1.0.0 or 1.0.0-rc.0\n${USAGE}`);
  if (o.backendRepo === "") fail(`--backend-repo (or ABFC_BACKEND_REPO) is required\n${USAGE}`);
  return o;
}

const mb = (n) => `${(n / (1024 * 1024)).toFixed(2)} MB`;

async function main() {
  const started = Date.now();
  const o = parseArgv(process.argv.slice(2));
  const entry = join(repoRoot, "packages", "cli", "dist", "src", "exe.js");
  if (!existsSync(entry)) fail("packages/cli/dist/src/exe.js is missing: run npm run build first");

  // 1. pins + allowlist
  const pins = loadPins(pinsFile);
  const allow = loadAllowlist(allowlistFile);
  for (const [label, value] of [
    ["python.sha256", pins.python.sha256],
    ["node.sha256", pins.node.sha256],
    ["node.licenseSha256", pins.node.licenseSha256],
  ]) {
    if (value === "") fail(`pin ${label} is empty: run node scripts/release/fetch-pins.mjs --download --record (needs approval)`);
  }

  // 2. node.exe
  const nodeV = pins.node.version;
  const cachedNode = join(cacheDir, `node-v${nodeV}-win-x64.exe`);
  let nodeExe = o.nodeExe;
  if (nodeExe === "") {
    if (existsSync(cachedNode)) nodeExe = cachedNode;
    else if (process.version === `v${nodeV}`) nodeExe = process.execPath;
    else fail(`no node.exe for v${nodeV}: pass --node-exe or run fetch-pins --download --only node-exe (needs approval)`);
  }
  nodeExe = resolve(nodeExe);
  const nodeSha = sha256File(nodeExe);
  if (nodeSha !== pins.node.sha256) {
    if (!o.dev) fail(`${nodeExe} has sha256 ${nodeSha}, the pin is ${pins.node.sha256}`);
    console.warn("build-exe: --dev: node.exe differs from the pin");
  }
  const help = spawnSync(nodeExe, ["--help"], { encoding: "utf8", windowsHide: true });
  if (!String(help.stdout).includes("--build-sea")) fail(`${nodeExe} does not support --build-sea`);

  // 3. bundle
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const cjs = join(workDir, "abfc.cjs");
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    outfile: cjs,
    metafile: true,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
    // ESLint's config loader (node_modules/eslint/lib/config/config-loader.js) imports jiti only to load TypeScript eslint
    // configs; abfc passes its own config and never reaches that path, and jiti is not installed.
    external: ["jiti", "jiti/package.json"],
    define: { "import.meta.url": "__abfc_import_meta_url" },
    banner: { js: 'const __abfc_import_meta_url = require("node:url").pathToFileURL(process.execPath).href;' },
  });
  const bundleBytes = statSync(cjs).size;

  // 4. notices
  const nodeLicense = join(cacheDir, `node-v${nodeV}-LICENSE.txt`);
  const pythonZipFile = join(cacheDir, `python-${pins.python.version}-embed-amd64.zip`);
  for (const f of [nodeLicense, pythonZipFile]) if (!existsSync(f)) fail(`missing ${f}: run node scripts/release/fetch-pins.mjs --download (needs approval)`);
  if (sha256File(nodeLicense) !== pins.node.licenseSha256) fail("Node LICENSE in the cache does not match node.licenseSha256");
  const pythonZip = readFileSync(pythonZipFile);
  if (sha256Buf(pythonZip) !== pins.python.sha256) fail("the Python zip in the cache does not match python.sha256");
  const pythonFiles = embedPythonFiles(pythonZip);

  const vendored = vendorBackend({
    repoDir: resolve(o.backendRepo),
    commit: pins.backend.commit,
    version: pins.backend.version,
    patterns: allow.backend,
  });
  if (pins.backend.filesSha256 === "") {
    if (o.record) {
      pins.backend.filesSha256 = vendored.filesSha256;
      savePins(pinsFile, pins);
      console.log(`recorded backend.filesSha256 ${vendored.filesSha256}`);
    } else if (!o.dev) {
      fail("pin backend.filesSha256 is empty: run once with --record (or --dev for an unreleased build)");
    }
  } else if (pins.backend.filesSha256 !== vendored.filesSha256) {
    if (!o.dev) fail(`vendored backend files hash ${vendored.filesSha256} differs from the pin ${pins.backend.filesSha256}`);
    console.warn("build-exe: --dev: backend files differ from the pin");
  }
  const backendLicense = vendored.files.get("LICENSE");
  if (backendLicense === undefined) fail("the vendored backend has no LICENSE");

  const notices = noticesText({
    packages: packageDirsFromMetafile(result.metafile, repoRoot),
    extras: [
      { name: "Node.js", version: nodeV, license: "MIT", text: readFileSync(nodeLicense, "utf8") },
      { name: "Python (embeddable)", version: pins.python.version, license: "PSF-2.0", text: pythonFiles.get("python/LICENSE.txt").toString("utf8") },
      { name: "abf-mod-editor-mcp (backend)", version: pins.backend.version, license: "see LICENSE", text: backendLicense.toString("utf8") },
    ],
  });
  const noticesFile = join(workDir, "THIRD-PARTY-NOTICES.txt");
  writeFileSync(noticesFile, notices, "utf8");

  // 5. runtime.zip
  const files = collectRuntimeFiles({ repoRoot, backendFiles: vendored.files, pythonFiles, notices });
  const sel = selectAllowed([...files.keys()], allow.runtime);
  if (sel.unmatchedPatterns.length > 0) fail(`runtime allowlist patterns matched nothing: ${sel.unmatchedPatterns.join(", ")}`);
  if (sel.rejected.length > 0) fail(`files outside the runtime allowlist: ${sel.rejected.slice(0, 10).join(", ")}`);
  for (const [name, data] of files) checkNoUserPaths(name, data);
  const { zip, manifest } = buildRuntimeZip(files, o.version);
  rmSync(runtimeOut, { recursive: true, force: true });
  mkdirSync(runtimeOut, { recursive: true });
  const zipFile = join(runtimeOut, "runtime.zip");
  const manifestFile = join(runtimeOut, "runtime.sha256.json");
  writeFileSync(zipFile, zip);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // 6. SEA
  rmSync(exeOut, { recursive: true, force: true });
  mkdirSync(exeOut, { recursive: true });
  const exeFile = join(exeOut, "abfc.exe");
  const seaConfig = join(workDir, "sea-config.json");
  // The SEA blob embeds the `main` path as written, so every path is relative to workDir (the cwd of the build): no user path or
  // worktree folder ends up in abfc.exe.
  const fromWork = (p) => relative(workDir, p);
  writeFileSync(
    seaConfig,
    `${JSON.stringify(
      {
        main: fromWork(cjs),
        output: fromWork(exeFile),
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: true,
        assets: { "runtime.zip": fromWork(zipFile), "runtime.sha256.json": fromWork(manifestFile) },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const sea = spawnSync(nodeExe, ["--build-sea", "sea-config.json"], { stdio: "inherit", windowsHide: true, cwd: workDir });
  if (sea.status !== 0) fail(`node --build-sea failed (exit ${sea.status})`);

  // 7. strip the Node signature, notices, build-info
  const stripped = stripAuthenticode(readFileSync(exeFile));
  if (stripped.removed) writeFileSync(exeFile, stripped.buf);
  try {
    checkNoBuildPathsInBinary("abfc.exe", readFileSync(exeFile));
  } catch (e) {
    fail(e.message);
  }
  copyFileSync(noticesFile, join(exeOut, "THIRD-PARTY-NOTICES.txt"));
  const exeBytes = statSync(exeFile).size;
  const info = {
    version: o.version,
    release: !o.dev,
    node: { version: nodeV, sha256: nodeSha },
    python: { version: pins.python.version, sha256: pins.python.sha256 },
    backend: { version: pins.backend.version, commit: pins.backend.commit, filesSha256: vendored.filesSha256 },
    runtimeZipSha256: manifest.zipSha256,
    exeSha256: sha256File(exeFile),
    signatureRemoved: stripped.removed,
    bundleBytes,
    exeBytes,
  };
  writeFileSync(join(exeOut, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
  console.log(
    `abfc.exe ${mb(exeBytes)}; bundle ${mb(bundleBytes)}; runtime.zip ${mb(zip.length)} (${files.size} files); signature removed: ${stripped.removed}; ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
