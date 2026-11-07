import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, Profile } from "@abfc/ir";
import { TS_VERSION, buildHir, checkProject, compileTests, loadProgram, loadedFromProgram, lower, lowerChecked, ownedManualFilter, tsDiagnostics } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures and packages/env/profiles
const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

const key = (d: Diagnostic): string =>
  `${d.code}|${d.severity}|${d.span?.file ?? ""}|${d.span?.line ?? 0}|${d.span?.col ?? 0}|${d.message}`;

/** What `abfc check` computed before checkProject existed: HIR, lowering with validation, tests. */
function oldPath(dir: string): { diagnostics: Diagnostic[]; tests: number; ir: boolean } {
  const loaded = loadProgram(dir);
  const hir = buildHir(loaded, config, profile);
  const diagnostics: Diagnostic[] = [...hir.diagnostics];
  if ([...loaded.diagnostics, ...hir.diagnostics].some((d) => d.severity === "error")) return { diagnostics, tests: 0, ir: false };
  const ir = lower(hir, profile);
  const problems = validateIrModule(ir);
  for (const p of problems) diagnostics.push({ severity: "error", code: "ABFC2099", message: `internal: ${p}` });
  if (problems.length > 0) return { diagnostics, tests: 0, ir: false };
  const compiled = compileTests(loaded, profile);
  diagnostics.push(...compiled.diagnostics);
  return { diagnostics, tests: compiled.cases.length, ir: true };
}

for (const name of ["project", "phase2", "phase3", "phase4"]) {
  test(`checkProject on fixture ${name} matches the old check path`, () => {
    const dir = fixture(name);
    const old = oldPath(dir);
    const loaded = loadProgram(dir);
    const res = checkProject(loaded, config, profile);
    assert.deepEqual(res.diagnostics.map(key).sort(), old.diagnostics.map(key).sort());
    assert.equal(res.tests, old.tests);
    assert.equal(res.ir !== null, old.ir);
  });
}

test("checkProject reports no loaded.diagnostics and keeps TypeScript errors out of the IR", () => {
  const loaded = loadProgram(fixture("project"));
  const res = checkProject(loaded, config, profile);
  const loadedKeys = new Set(loaded.diagnostics.map(key));
  for (const d of res.diagnostics) assert.ok(!loadedKeys.has(key(d)), `${key(d)} is not a loaded diagnostic`);
  // the project fixture holds Bad.ts: subset errors, so no IR
  assert.equal(res.ir, null);
  assert.ok(res.diagnostics.some((d) => d.severity === "error"));
});

test("loadedFromProgram and tsDiagnostics agree with loadProgram", () => {
  const dir = fixture("phase2");
  const a = loadProgram(dir);
  const b = loadedFromProgram(dir, a.program, tsDiagnostics(a.program, dir));
  assert.deepEqual(b.files.classes.map((f) => f.fileName), a.files.classes.map((f) => f.fileName));
  assert.deepEqual(b.files.tests.map((f) => f.fileName), a.files.tests.map((f) => f.fileName));
  assert.deepEqual(b.diagnostics.map(key), a.diagnostics.map(key));
});

test("loadProgram accepts the previous program", () => {
  const dir = fixture("phase2");
  const a = loadProgram(dir);
  const b = loadProgram(dir, a.program);
  assert.deepEqual(b.diagnostics.map(key), a.diagnostics.map(key));
  assert.deepEqual(b.files.classes.map((f) => f.fileName), a.files.classes.map((f) => f.fileName));
});

test("lowerChecked lowers a clean HIR", () => {
  const loaded = loadProgram(fixture("phase2"));
  const hir = buildHir(loaded, config, profile);
  const res = lowerChecked(hir, profile);
  assert.deepEqual(res.diagnostics, []);
  assert.ok(res.ir !== null && res.ir.assets.length > 0);
});

test("ownedManualFilter is null for a directory without manifests", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-svc-"));
  try {
    assert.equal(ownedManualFilter(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TS_VERSION is the version of the typescript module", () => {
  assert.match(TS_VERSION, /^\d+\.\d+\.\d+/);
});
