import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Diagnostic, Profile } from "@abfc/ir";
import { addDirectorTagFix, buildHir, loadProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/phase7
const fixture = fileURLToPath(new URL("../../test/fixtures/phase7", import.meta.url));
const profile = { id: "test" } as unknown as Profile;

const SOURCE = [
  'import { blueprint, director, event } from "@abfc/runtime";',
  'import type { GameplayTag } from "@abfc/runtime";',
  'import { Actor } from "/Script/FakeEngine";',
  "",
  'const NOT_LITERAL = "ClassManager.EntityDirector.Var";',
  "// stands for the constants of the generated .abfc/tags.d.ts",
  "declare const ClassManager: { readonly EntityDirector: { readonly Known: GameplayTag<\"ClassManager.EntityDirector.Known\"> } };",
  "",
  '@director("RowLiteral", "ClassManager.EntityDirector.Literal")',
  "@blueprint()",
  "export class BPC_Literal extends Actor {",
  "  @event Ping(): void {}",
  "}",
  "",
  '@director("RowConst", ClassManager.EntityDirector.Known)',
  "@blueprint()",
  "export class BPC_Const extends Actor {",
  "  @event Ping(): void {}",
  "}",
  "",
  '@director("RowBad", "Bad Tag")',
  "@blueprint()",
  "export class BPC_Bad extends Actor {",
  "  @event Ping(): void {}",
  "}",
  "",
  '@director("RowVar", NOT_LITERAL)',
  "@blueprint()",
  "export class BPC_Var extends Actor {",
  "  @event Ping(): void {}",
  "}",
  "",
  '@director("RowPrefix", "Other.Tag.Name")',
  "@blueprint()",
  "export class BPC_Prefix extends Actor {",
  "  @event Ping(): void {}",
  "}",
  "",
  '@director("RowMissing")',
  "@blueprint()",
  "export class BPC_Missing extends Actor {",
  "  @event Ping(): void {}",
  "}",
  "",
].join("\n");

/** Runs the frontend on a copy of the director fixture whose src holds only `Tags.ts` and a generated-style tags.d.ts. */
function withProject<T>(f: (dir: string) => T): T {
  // inside the package tree so that `@abfc/runtime` still resolves through the workspace node_modules
  const dir = mkdtempSync(join(fileURLToPath(new URL("./", import.meta.url)), "dirtags-"));
  try {
    cpSync(fixture, dir, { recursive: true });
    rmSync(join(dir, "src"), { recursive: true, force: true });
    rmSync(join(dir, "extra"), { recursive: true, force: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "Tags.ts"), SOURCE);
    return f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const inTags = (ds: Diagnostic[]): Diagnostic[] => ds.filter((d) => d.span?.file === "src/Tags.ts");

test("@director tag: a string literal and a GameplayTag constant both set director.tag", () => {
  withProject((dir) => {
    const hir = buildHir(loadProgram(dir), { mod: "TestMod" }, profile);
    const by = (n: string) => hir.classes.find((c) => c.name === n)!;
    assert.deepEqual(by("BPC_Literal").director, { row: "RowLiteral", asset: "/TestMod/DataTables/DT_ClassManager/RowLiteral", tag: "ClassManager.EntityDirector.Literal" });
    assert.equal(by("BPC_Const").director!.tag, "ClassManager.EntityDirector.Known");
    const first = SOURCE.split("\n").findIndex((l) => l.startsWith('@director("RowLiteral"')) + 1;
    const last = SOURCE.split("\n").findIndex((l) => l.startsWith('@director("RowBad"'));
    assert.deepEqual(inTags(hir.diagnostics).filter((d) => d.span!.line >= first && d.span!.line <= last), []);
  });
});

test("ABFC2080: a bad tag or a tag that is not a literal / GameplayTag is an error and the director is dropped", () => {
  withProject((dir) => {
    const hir = buildHir(loadProgram(dir), { mod: "TestMod" }, profile);
    const errors = inTags(hir.diagnostics).filter((d) => d.code === "ABFC2080");
    assert.equal(errors.length, 2);
    assert.ok(errors.some((d) => /"Bad Tag"/.test(d.message)));
    assert.ok(errors.some((d) => /string literal or a GameplayTag/.test(d.message)));
    assert.equal(hir.classes.find((c) => c.name === "BPC_Bad")!.director, undefined);
    assert.equal(hir.classes.find((c) => c.name === "BPC_Var")!.director, undefined);
  });
});

test("ABFC2081: a tag outside ClassManager.EntityDirector. is a warning and still recorded", () => {
  withProject((dir) => {
    const hir = buildHir(loadProgram(dir), { mod: "TestMod" }, profile);
    const w = inTags(hir.diagnostics).filter((d) => d.code === "ABFC2081");
    assert.equal(w.length, 1);
    assert.equal(w[0]!.severity, "warning");
    assert.equal(hir.classes.find((c) => c.name === "BPC_Prefix")!.director!.tag, "Other.Tag.Name");
  });
});

test("ABFC2079: no tag is a warning with the suggested tag in data, and the quick fix inserts it", () => {
  withProject((dir) => {
    const loaded = loadProgram(dir);
    const hir = buildHir(loaded, { mod: "TestMod" }, profile);
    const w = inTags(hir.diagnostics).filter((d) => d.code === "ABFC2079");
    assert.equal(w.length, 1);
    assert.deepEqual(w[0]!.data, { tag: "ClassManager.EntityDirector.RowMissing" });
    assert.equal(hir.classes.find((c) => c.name === "BPC_Missing")!.director!.tag, undefined);
    const sf = ts.createSourceFile("Tags.ts", SOURCE, ts.ScriptTarget.ES2022, true);
    const line = SOURCE.split("\n").findIndex((l) => l.startsWith('@director("RowMissing")'));
    const start = SOURCE.split("\n").slice(0, line).join("\n").length + 1;
    const edits = addDirectorTagFix(sf, start, start + 5, "ClassManager.EntityDirector.RowMissing")!;
    assert.equal(edits.length, 1);
    const fixed = SOURCE.slice(0, edits[0]!.start) + edits[0]!.newText + SOURCE.slice(edits[0]!.start + edits[0]!.length);
    assert.match(fixed, /@director\("RowMissing", "ClassManager\.EntityDirector\.RowMissing"\)/);
    // a decorator that already has a tag has no fix
    const withTag = SOURCE.indexOf('@director("RowLiteral"');
    assert.equal(addDirectorTagFix(sf, withTag, withTag + 5, "X.Y"), undefined);
  });
});
