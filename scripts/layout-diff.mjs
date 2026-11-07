#!/usr/bin/env node
// Dev only (not published): checks that two T3D exports of a Widget Blueprint agree outside the owned graphs.
//
//   node scripts/layout-diff.mjs [--strict] <before.t3d> <after.t3d> [--owned-var NAME]...
//
// Default (normalized): the blocks of the layout are compared in sorted order inside each run of sibling blocks, each block byte
// for byte, so "identical" means the same multiset of byte-identical sibling blocks (the editor writes siblings in memory order,
// which differs between a freshly loaded asset and one reloaded from disk). --strict compares the raw export order instead.
//
// Exit 0: layout identical. Exit 1: differs (first difference and up to 20 differing lines are printed). Exit 2: usage.
// Build first: npm run build.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { layoutRegion } from "../packages/ir/dist/src/index.js";

function usage(message) {
  if (message) process.stderr.write(`layout-diff: ${message}\n`);
  process.stderr.write("usage: node scripts/layout-diff.mjs [--strict] <before.t3d> <after.t3d> [--owned-var NAME]...\n");
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({ options: { "owned-var": { type: "string", multiple: true }, strict: { type: "boolean" } }, allowPositionals: true, strict: true });
} catch (e) {
  usage(e instanceof Error ? e.message : String(e));
}
const [beforePath, afterPath, ...rest] = parsed.positionals;
if (beforePath === undefined || afterPath === undefined || rest.length > 0) usage("expected exactly two export files");
const owned = parsed.values["owned-var"] ?? [];
const opts = parsed.values.strict === true ? { sortSiblings: false } : {};

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch (e) {
    process.stderr.write(`layout-diff: cannot read ${p}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
};
const a = layoutRegion(read(beforePath), owned, opts);
const b = layoutRegion(read(afterPath), owned, opts);

const n = Math.max(a.length, b.length);
const diffs = [];
for (let k = 0; k < n && diffs.length < 20; k++) {
  if (a[k] !== b[k]) diffs.push(k);
}
if (diffs.length === 0) {
  process.stdout.write(`layout identical (${a.length} lines)\n`);
  process.exit(0);
}
const clip = (s) => (s === undefined ? "<missing>" : s.length > 200 ? `${s.slice(0, 200)}...` : s);
process.stdout.write(`layout differs: ${a.length} lines before, ${b.length} lines after; first difference at line ${(diffs[0] ?? 0) + 1}\n`);
for (const k of diffs) {
  process.stdout.write(`  line ${k + 1}\n    - ${clip(a[k])}\n    + ${clip(b[k])}\n`);
}
process.exit(1);
