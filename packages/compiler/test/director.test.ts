import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Profile } from "@abfc/ir";
import { buildHir, loadProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/phase7
const dir = fileURLToPath(new URL("../../test/fixtures/phase7", import.meta.url));
const profile = { id: "test" } as unknown as Profile;

const loaded = loadProgram(dir);
const hinted = buildHir(loaded, { mod: "TestMod", migrationHints: true }, profile);
const quiet = buildHir(loaded, { mod: "TestMod", migrationHints: false }, profile);
const inDirectors = (ds: Diagnostic[]): Diagnostic[] => ds.filter((d) => d.span?.file === "src/Directors.ts");
const lineOf = (name: string): number => {
  const i = loaded.files.classes.find((f) => f.fileName.endsWith("/Directors.ts"))!.text.split("\n").findIndex((l) => l.includes(`class ${name} `));
  return i + 1;
};
const codesOf = (ds: Diagnostic[], name: string): string[] => ds.filter((d) => d.span?.line === lineOf(name)).map((d) => d.code);

test("@director records the row and its asset under the class-manager table", () => {
  const c = hinted.classes.find((x) => x.name === "BPC_Dir")!;
  assert.deepEqual(c.director, { row: "EntityDirector_Test", asset: "/TestMod/DataTables/DT_ClassManager/EntityDirector_Test" });
  assert.equal(c.classManagerRow, undefined);
  assert.deepEqual(codesOf(inDirectors(hinted.diagnostics), "BPC_Dir"), []);
});

test("classManager.table moves the row asset", () => {
  const h = buildHir(loaded, { mod: "TestMod", classManagerTable: "Rows/Managers" }, profile);
  assert.equal(h.classes.find((x) => x.name === "BPC_Dir")!.director!.asset, "/TestMod/Rows/Managers/EntityDirector_Test");
});

test("ABFC2061: two directors, a non-literal row, or director together with classManagerRow", () => {
  const ds = inDirectors(hinted.diagnostics);
  const two = ds.filter((d) => d.code === "ABFC2061" && d.message === "one @director per class");
  assert.equal(two.length, 1);
  assert.ok(ds.some((d) => d.code === "ABFC2061" && d.message === "@director takes the row name as a string literal"));
  const both = ds.filter((d) => d.code === "ABFC2061" && d.message === "use @director or classManagerRow, not both");
  assert.equal(both.length, 1);
  for (const n of ["BPC_DirTwo", "BPC_NonLiteral", "BPC_Both"]) assert.equal(hinted.classes.find((x) => x.name === n)!.director, undefined);
  // the option together with a director is not also called deprecated
  assert.deepEqual(codesOf(ds, "BPC_Both"), []);
  assert.ok(ds.filter((d) => d.code === "ABFC2061" && d.message.includes("not both"))[0]!.span!.line === lineOf("BPC_Both") - 1);
});

test("ABFC2073: a row name with a bad character", () => {
  const d = inDirectors(hinted.diagnostics).filter((x) => x.code === "ABFC2073");
  assert.equal(d.length, 1);
  assert.match(d[0]!.message, /^row name "Bad-Row" contains "-"/);
});

test("ABFC2074: a widget class or a struct cannot have a director", () => {
  const d = inDirectors(hinted.diagnostics).filter((x) => x.code === "ABFC2074");
  assert.equal(d.length, 2);
  assert.match(d[0]!.message, /^@director only applies to a non-widget @blueprint class$/);
  assert.equal(hinted.classes.find((x) => x.name === "W_Dir")!.director, undefined);
});

test("ABFC2075: the second class with the same row (case-insensitive) is an error naming the first", () => {
  const d = hinted.diagnostics.filter((x) => x.code === "ABFC2075");
  assert.equal(d.length, 1);
  assert.equal(d[0]!.severity, "error");
  assert.equal(d[0]!.message, "class-manager row entitydirector_test of BPC_DirDup is already used by BPC_Dir");
  assert.equal(d[0]!.span!.line, lineOf("BPC_DirDup"));
});

test("ABFC2076: classManagerRow alone is deprecated, only with migration hints", () => {
  const d = hinted.diagnostics.filter((x) => x.code === "ABFC2076");
  assert.equal(d.length, 1);
  assert.equal(d[0]!.severity, "warning");
  assert.equal(d[0]!.message, 'classManagerRow is deprecated; use @director("EntityDirector_Old")');
  assert.equal(d[0]!.span!.line, lineOf("BPC_OldRow") - 1);
  assert.equal(quiet.diagnostics.filter((x) => x.code === "ABFC2076").length, 0);
  // the option keeps its verify-only meaning
  assert.equal(hinted.classes.find((x) => x.name === "BPC_OldRow")!.classManagerRow, "/TestMod/DataTables/DT_ClassManager/EntityDirector_Old");
});
