import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Diagnostic, Profile } from "@abfc/ir";
import { assetPathOf, buildHir, loadProgram, pathContextOf } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/phase7
const dir = fileURLToPath(new URL("../../test/fixtures/phase7", import.meta.url));
const profile = { id: "test" } as unknown as Profile;

const loaded = loadProgram(dir);
const hinted = buildHir(loaded, { mod: "TestMod", migrationHints: true }, profile);
const hintedDiags = hinted.diagnostics;
const quiet = buildHir(loaded, { mod: "TestMod", migrationHints: false }, profile).diagnostics;

const pathOf = (name: string): string | undefined =>
  [...hinted.classes, ...hinted.structs].find((x) => x.name === name)?.path;
const inFile = (ds: Diagnostic[], file: string): Diagnostic[] => ds.filter((d) => d.span?.file === file);
const codesIn = (ds: Diagnostic[], file: string): string[] => inFile(ds, file).map((d) => d.code).sort();

test("fixture phase7 loads without TypeScript errors", () => {
  assert.deepEqual(loaded.diagnostics, []);
});

test("derived paths: folder under src plus class name; top level has no folder; structs too", () => {
  assert.equal(pathOf("MyRelay"), "/TestMod/Relays/MyRelay");
  assert.equal(pathOf("TopLevel"), "/TestMod/TopLevel");
  assert.equal(pathOf("S_Top"), "/TestMod/S_Top");
  const my = hinted.classes.find((c) => c.name === "MyRelay")!;
  assert.equal(my.pathDerived, true);
  assert.equal(my.classPath, "/TestMod/Relays/MyRelay.MyRelay_C");
  assert.equal(hinted.structs.find((s) => s.name === "S_Top")!.objectPath, "/TestMod/S_Top.S_Top");
});

test("path: relative or absolute override", () => {
  assert.equal(pathOf("Rel"), "/TestMod/Other/Kept");
  assert.equal(pathOf("Abs"), "/TestMod/Moved/Abs");
  assert.equal(hinted.classes.find((c) => c.name === "Rel")!.pathDerived, false);
});

test("migration hints: ABFC2005 for an absolute path, ABFC2006 for the derived path (not both)", () => {
  const ds = inFile(hintedDiags, "src/Paths.ts");
  const abs = ds.filter((d) => d.code === "ABFC2005");
  assert.equal(abs.length, 1);
  assert.equal(abs[0]!.severity, "warning");
  assert.match(abs[0]!.message, /write it relative: "Moved\/Abs"/);
  const same = ds.filter((d) => d.code === "ABFC2006");
  assert.equal(same.length, 1);
  assert.match(same[0]!.message, /derives for Same/);
  // Same (line of `path: "Same"`) has no ABFC2005; Abs (its line) has no ABFC2006
  assert.notEqual(abs[0]!.span!.line, same[0]!.span!.line);
  assert.deepEqual(ds.filter((d) => d.span!.line === same[0]!.span!.line).map((d) => d.code), ["ABFC2006"]);
  assert.deepEqual(ds.filter((d) => d.span!.line === abs[0]!.span!.line).map((d) => d.code), ["ABFC2005"]);
});

test("an absolute path names the mod case-insensitively: ABFC2005 with a relative fix, not ABFC2001", () => {
  const ds = inFile(hintedDiags, "src/CasedPath.ts");
  assert.deepEqual(ds.map((d) => d.code), ["ABFC2005"]);
  assert.match(ds[0]!.message, /write it relative: "Cased\/CasedAbs"/);
  assert.equal(pathOf("CasedAbs"), "/TestMod/Cased/CasedAbs");
});

test("without migration hints there is no ABFC2005 / ABFC2006", () => {
  assert.equal(quiet.filter((d) => d.code === "ABFC2005" || d.code === "ABFC2006").length, 0);
});

test("a path outside the mod is ABFC2001 and the class is not built", () => {
  const ds = inFile(hintedDiags, "src/Paths.ts").filter((d) => d.code === "ABFC2001");
  assert.equal(ds.length, 1);
  assert.match(ds[0]!.message, /Foreign must be a string literal under "\/TestMod\/"/);
  assert.equal(pathOf("Foreign"), undefined);
});

test("a folder with a dash is ABFC2002 naming the folder and the character", () => {
  const ds = inFile(hintedDiags, "src/bad-dir/Dashed.ts");
  assert.deepEqual(ds.map((d) => d.code), ["ABFC2002"]);
  assert.match(ds[0]!.message, /folder "bad-dir"/);
  assert.match(ds[0]!.message, /contains "-"/);
  assert.equal(ds[0]!.fix, "rename the folder or class, or give path:");
  assert.equal(pathOf("Dashed"), undefined);
});

test("a class file outside the source root without path: is ABFC2003", () => {
  const ds = inFile(hintedDiags, "extra/Outside.ts");
  assert.deepEqual(ds.map((d) => d.code), ["ABFC2003"]);
  assert.match(ds[0]!.message, /extra\/Outside\.ts is outside the source root "src": move it under src\/ or give path:/);
  assert.equal(pathOf("Outside"), undefined);
});

test("only the expected diagnostics appear in the fixture", () => {
  assert.deepEqual(codesIn(hintedDiags, "src/Relays/MyRelay.ts"), []);
  assert.deepEqual(codesIn(hintedDiags, "src/Top.ts"), []);
  assert.deepEqual(codesIn(quiet, "src/Paths.ts"), ["ABFC2001"]);
});

test("sourceRoot option moves the root: extra/ becomes the source root", () => {
  const h = buildHir(loaded, { mod: "TestMod", sourceRoot: "extra" }, profile);
  assert.equal(h.classes.find((c) => c.name === "Outside")?.path, "/TestMod/Outside");
  assert.deepEqual(codesIn(h.diagnostics, "extra/Outside.ts"), []);
  // src files are now outside the source root: ABFC2003 for those without path:
  assert.ok(inFile(h.diagnostics, "src/Top.ts").some((d) => d.code === "ABFC2003"));
});

test("assetPathOf without a bound context accepts an absolute literal path only", () => {
  const other = loadProgram(dir);
  const sf = other.files.classes.find((f) => f.fileName.endsWith("/Paths.ts"))!;
  assert.equal(pathContextOf(sf), undefined);
  const results = sf.statements.filter(ts.isClassDeclaration).map((s) => assetPathOf(s, "blueprint")?.path);
  assert.deepEqual(results, [undefined, "/TestMod/Moved/Abs", undefined, "/OtherMod/X"]);
});

test("ABFC2007: a second class with the same asset path (case-insensitive) is an error naming the first", () => {
  const dups = hintedDiags.filter((d) => d.code === "ABFC2007");
  assert.equal(dups.length, 1);
  assert.equal(dups[0]!.severity, "error");
  assert.match(dups[0]!.message, /^asset path \/TestMod\/Relays\/MyRelay of Dup is already used by MyRelay \(src\/Relays\/MyRelay\.ts\)$/);
  assert.equal(dups[0]!.span!.file, "src/Dup.ts");
  // the quiet run reports it too: it is not a migration hint
  assert.equal(quiet.filter((d) => d.code === "ABFC2007").length, 1);
});

test("ABFC2007 is whole-program only: a subset build reports no duplicates", () => {
  const sf = loaded.files.classes.find((f) => f.fileName.endsWith("/Dup.ts"))!;
  const h = buildHir(loaded, { mod: "TestMod", migrationHints: true }, profile, [sf]);
  assert.deepEqual(h.diagnostics.map((d) => d.code), []);
});

test("ABFC2008: an import by /<mod>/ is a warning with the @mod form; @mod imports are clean", () => {
  const ds = inFile(hintedDiags, "src/Imports.ts");
  assert.deepEqual(ds.map((d) => d.code), ["ABFC2008"]);
  assert.equal(ds[0]!.severity, "warning");
  assert.equal(ds[0]!.message, 'import from "/TestMod/Relays/BP_Hand" names the mod; use "@mod/Relays/BP_Hand"');
  assert.equal(ds[0]!.span!.line, 1);
  assert.deepEqual(codesIn(quiet, "src/Imports.ts"), []);
});
