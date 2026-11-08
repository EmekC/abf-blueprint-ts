#!/usr/bin/env node
// Check the parent chains of every class in written stub folders.
//
//   node scripts/stub-chain-audit.mjs --stubs <profileDir> [--stubs <dir> ...] [--json]
//
// <profileDir> is a stub profile folder (<project>/.abfc/stubs/<profile>) with Script/, Game/ and Mod/ below it. Every `*.d.ts` below it
// is read (nothing is written). One line is printed per finding: `<kind>  <cls>  <detail>`
//   opaque-ancestor    a class with members extends (directly or further up) a members-less placeholder
//   unresolved-parent  the parent named after `extends` is not declared or imported
//   cycle              the parent chain loops
//   unknown-parent     a placeholder extends UObject because its real parent is not known (information only)
// Exit 1 when any opaque-ancestor, unresolved-parent or cycle is found; unknown-parent never fails. `--json` prints the audit objects.
// Requires `npm run build`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stubgenPath = join(repo, "packages", "stubgen", "dist", "src", "index.js");
if (!existsSync(stubgenPath)) {
  console.error("stub-chain-audit: run `npm run build` first");
  process.exit(2);
}
const { auditStubChains } = await import(pathToFileURL(stubgenPath).href);

const usage = "usage: node scripts/stub-chain-audit.mjs --stubs <profileDir> [--stubs <dir> ...] [--json]";
const dirs = [];
let asJson = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--stubs" && argv[i + 1] !== undefined) dirs.push(resolve(argv[++i]));
  else if (a === "--json") asJson = true;
  else {
    console.error(usage);
    process.exit(2);
  }
}
if (dirs.length === 0) {
  console.error(usage);
  process.exit(2);
}

function readStubs(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".d.ts")) files.set(relative(root, p).split("\\").join("/"), readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return files;
}

const FAILING = new Set(["opaque-ancestor", "unresolved-parent", "cycle"]);
let failed = false;
const results = [];
for (const dir of dirs) {
  if (!existsSync(dir)) {
    console.error(`stub-chain-audit: no such folder: ${dir}`);
    process.exit(2);
  }
  const audit = auditStubChains(readStubs(dir));
  results.push({ dir, ...audit });
  if (audit.findings.some((f) => FAILING.has(f.kind))) failed = true;
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.dir}: classes ${r.classes}, opaque ${r.opaque}`);
    for (const f of r.findings) console.log(`${f.kind}  ${f.cls}  ${f.detail}`);
    const counts = new Map();
    for (const f of r.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
    console.log(["opaque-ancestor", "unresolved-parent", "cycle", "unknown-parent"].map((k) => `${k} ${counts.get(k) ?? 0}`).join(", "));
  }
}
process.exit(failed ? 1 : 0);
