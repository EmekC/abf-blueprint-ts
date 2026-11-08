#!/usr/bin/env node
// Packs the public @abfc/* packages into tarballs and checks them against release/allowlist.json "npm" (design 18.10).
//
//   node scripts/release/pack-npm.mjs [--dry-run] [--out <dir>]
//
// --dry-run  run `npm pack --dry-run` (nothing is written); only the file lists and manifests are checked
// --out      tarball folder (default build/release/npm; emptied first unless --dry-run)
// Non-dry runs write <out>/packages.json: [{name, version, filename, sha256}] in publish order. Requires `npm run build`.
// Nothing is ever published by this script.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllowlist } from "./lib/allowlist.mjs";
import { checkManifest, checkPackFiles, publishOrder } from "./lib/npm.mjs";
import { sha256File } from "./lib/pins.mjs";
import { readWorkspace } from "./lib/versions.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = "usage: node scripts/release/pack-npm.mjs [--dry-run] [--out <dir>]";

function fail(message) {
  console.error(`pack-npm: ${message}`);
  process.exit(1);
}

function parseArgv(argv) {
  const o = { dry: false, out: join(repoRoot, "build", "release", "npm") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dry = true;
    else if (a === "--out") o.out = resolve(String(argv[++i] ?? ""));
    else fail(`unknown argument ${a}\n${USAGE}`);
  }
  return o;
}

function npmPack(name, dry, out) {
  const args = ["pack", "-w", name, "--json", ...(dry ? ["--dry-run"] : ["--pack-destination", out])];
  const r = spawnSync("npm", args, { cwd: repoRoot, shell: process.platform === "win32", encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`npm ${args.join(" ")} failed (exit ${r.status})\n${r.stderr ?? ""}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    fail(`npm pack printed no JSON for ${name}:\n${(r.stdout ?? "").slice(0, 400)}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) fail(`npm pack returned ${Array.isArray(parsed) ? parsed.length : "no"} entries for ${name}`);
  return parsed[0];
}

function main() {
  const o = parseArgv(process.argv.slice(2));
  const allow = loadAllowlist(join(repoRoot, "release", "allowlist.json"));
  if (allow.npm === undefined || typeof allow.npm !== "object") fail('release/allowlist.json has no "npm" object');
  const pub = readWorkspace(repoRoot).filter((p) => p.json.private !== true);
  const cliVersion = pub.find((p) => p.json.name === "@abfc/cli")?.json.version;
  if (typeof cliVersion !== "string") fail("packages/cli/package.json has no version");

  const byName = new Map(pub.map((p) => [p.json.name, p]));
  const order = publishOrder(
    pub.map((p) => ({
      name: p.json.name,
      deps: [...Object.keys(p.json.dependencies ?? {}), ...Object.keys(p.json.peerDependencies ?? {}), ...Object.keys(p.json.optionalDependencies ?? {})],
    })),
  );

  const problems = [];
  for (const name of Object.keys(allow.npm)) if (!byName.has(name)) problems.push(`release/allowlist.json npm: ${name} is not a public package`);
  for (const name of order) if (allow.npm[name] === undefined) problems.push(`release/allowlist.json npm: no entry for ${name}`);

  if (!o.dry) {
    rmSync(o.out, { recursive: true, force: true });
    mkdirSync(o.out, { recursive: true });
  }

  const rows = [];
  const manifest = [];
  for (const name of order) {
    const pkg = byName.get(name);
    if (allow.npm[name] === undefined) continue;
    problems.push(...checkManifest(pkg.json, cliVersion));
    const packed = npmPack(name, o.dry, o.out);
    problems.push(...checkPackFiles(name, packed.files.map((f) => f.path), allow.npm[name]));
    if (packed.version !== cliVersion) problems.push(`${name}: npm packed version ${packed.version}, expected ${cliVersion}`);
    let size = packed.size;
    let sha = "";
    if (!o.dry) {
      const file = join(o.out, packed.filename);
      if (!existsSync(file)) {
        problems.push(`${name}: ${packed.filename} was not written`);
        continue;
      }
      size = statSync(file).size;
      sha = sha256File(file);
      manifest.push({ name, version: packed.version, filename: packed.filename, sha256: sha });
    }
    rows.push([name, packed.version, packed.files.length, size, sha]);
  }

  if (!o.dry && problems.length === 0) {
    writeFileSync(join(o.out, "packages.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const extra = readdirSync(o.out).filter((n) => n.endsWith(".tgz") && !manifest.some((m) => m.filename === n));
    for (const n of extra) problems.push(`${n} is in ${o.out} but not in the publish list`);
  }

  console.log(`pack-npm ${o.dry ? "(dry run) " : ""}abfc ${cliVersion}`);
  for (const [name, version, files, size, sha] of rows) {
    console.log(`  ${name.padEnd(22)} ${version.padEnd(8)} ${String(files).padStart(4)} files ${String(size).padStart(9)} B  ${sha.slice(0, 16)}`);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`  PROBLEM: ${p}`);
    console.error(`pack-npm: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`pack-npm: ok (${rows.length} packages${o.dry ? "" : ` in ${o.out}`})`);
}

main();
