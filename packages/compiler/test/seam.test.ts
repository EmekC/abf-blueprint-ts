import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// compiled to packages/compiler/dist/test/seam.test.js -> packages/
const packagesDir = fileURLToPath(new URL("../../../", import.meta.url));

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const IMPORTS_TS = /(?:from|import)\s*\(?\s*["']typescript["']|require\(\s*["']typescript["']\s*\)/;

function importers(dir: string): string[] {
  return tsFiles(dir)
    .filter((f) => IMPORTS_TS.test(readFileSync(f, "utf8")))
    .map((f) => relative(packagesDir, f).replaceAll("\\", "/"))
    .sort();
}

test("only the compiler frontend imports typescript", () => {
  const all: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const src = join(packagesDir, pkg, "src");
    if (existsSync(src)) all.push(...importers(src));
  }
  assert.ok(all.length > 0, "the frontend must import typescript");
  for (const f of all) assert.match(f, /^compiler\/src\/frontend\//, `${f} must not import typescript`);
});

test("lowering, planning and ownership never import typescript", () => {
  for (const d of ["lower", "plan", "ownership"]) {
    assert.deepEqual(importers(join(packagesDir, "compiler", "src", d)), [], `compiler/src/${d} imports typescript`);
  }
  assert.deepEqual(importers(join(packagesDir, "compiler", "src")).filter((f) => !f.startsWith("compiler/src/frontend/")), []);
});

test("the HIR types do not depend on typescript", () => {
  assert.doesNotMatch(readFileSync(join(packagesDir, "compiler", "src", "hir.ts"), "utf8"), IMPORTS_TS);
});
