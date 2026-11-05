import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Profile } from "@abfc/ir";
import { buildHir, checkSubset, compileTests, loadProgram } from "../src/index.js";
import type { HirExpr, HirStmt } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/project
const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profile = { id: "test" } as unknown as Profile;
const config = { mod: "TestMod" };

const loaded = loadProgram(projectDir);
const fileOf = (name: string) => {
  const sf = loaded.files.classes.find((f) => f.fileName.endsWith(`/${name}`));
  assert.ok(sf, `${name} is a root file`);
  return sf;
};
const inFile = (ds: Diagnostic[], file: string) => ds.filter((d) => d.span?.file === file);

test("project loads: class files and test files are split", () => {
  assert.deepEqual(loaded.files.classes.map((f) => f.fileName.slice(f.fileName.lastIndexOf("/") + 1)).sort(), ["Bad.ts", "Relay.ts"]);
  assert.deepEqual(loaded.files.tests.map((f) => f.fileName.slice(f.fileName.lastIndexOf("/") + 1)), ["Relay.test.ts"]);
});

const relay = buildHir(loaded, config, profile, [fileOf("Relay.ts")]);

test("Relay.ts is clean (TypeScript and subset)", () => {
  assert.deepEqual(inFile(loaded.diagnostics, "src/Relay.ts"), []);
  assert.deepEqual(inFile(loaded.diagnostics, "src/Relay.test.ts"), []);
  assert.deepEqual(relay.diagnostics, []);
});

function allExprs(s: HirStmt, out: HirExpr[]): void {
  const walk = (e: HirExpr): void => {
    out.push(e);
    switch (e.k) {
      case "getOn": case "field": walk(e.obj); break;
      case "out": walk(e.call); break;
      case "call": if (e.target) walk(e.target); e.args.forEach((a) => walk(a.value)); break;
      case "cast": case "isValid": walk(e.value); break;
      case "optional": walk(e.value); walk(e.then); break;
      case "eq": case "and": case "or": walk(e.a); walk(e.b); break;
      case "not": walk(e.e); break;
      case "length": walk(e.array); break;
      default: break;
    }
  };
  switch (s.k) {
    case "expr": walk(s.e); break;
    case "setSelf": walk(s.value); break;
    case "const": walk(s.init); break;
    case "if": walk(s.cond); s.then.forEach((x) => allExprs(x, out)); s.else.forEach((x) => allExprs(x, out)); break;
    case "forOf": walk(s.array); s.body.forEach((x) => allExprs(x, out)); break;
    default: break;
  }
}

test("HIR of Relay.UpdateTarget", () => {
  assert.equal(relay.classes.length, 1);
  const cls = relay.classes[0]!;
  assert.equal(cls.name, "BP_Relay");
  assert.equal(cls.path, "/TestMod/Relay/BP_Relay");
  assert.equal(cls.classPath, "/TestMod/Relay/BP_Relay.BP_Relay_C");
  assert.equal(cls.parent, "/Script/FakeEngine.Actor");
  assert.deepEqual(cls.manualUnits, ["HideAll"]);
  assert.equal(cls.events.length, 1);
  const ev = cls.events[0]!;
  assert.equal(ev.name, "UpdateTarget");
  assert.deepEqual(ev.params, []);
  assert.deepEqual(
    ev.body.map((s) => s.k),
    ["const", "const", "if", "const", "if", "setSelf", "setSelf", "const", "if", "const", "if", "forOf", "setSelf"],
  );

  const consts = ev.body.filter((s): s is Extract<HirStmt, { k: "const" }> => s.k === "const");
  assert.deepEqual(consts.map((c) => [c.name, c.uses]), [["player", 1], ["pot", 6], ["rowName", 2], ["row", 2], ["info", 6]]);
  assert.equal(consts[0]!.init.k, "cast");
  assert.equal(consts[3]!.init.type, "result");

  const exprs: HirExpr[] = [];
  ev.body.forEach((s) => allExprs(s, exprs));
  assert.deepEqual(exprs.flatMap((e) => (e.k === "eq" ? [e.kind] : [])), ["object", "name", "real", "real", "int"]);
  const loop = ev.body.find((s): s is Extract<HirStmt, { k: "forOf" }> => s.k === "forOf");
  assert.equal(loop?.elem, "object:/Game/Fake/WBP_Show.WBP_Show_C");
  assert.equal(loop?.name, "w");
  const exec = exprs.find((e) => e.k === "execIs");
  assert.ok(exec && exec.k === "execIs" && exec.pin === "Valid" && exec.negate);
  const casts = exprs.flatMap((e) => (e.k === "cast" ? [e.castPin] : []));
  assert.deepEqual(casts, ["AsBPFakeCharacter", "AsBPFakePot"]);

  assert.equal(relay.classMeta["/Game/Fake/WBP_Show.WBP_Show_C"], "/Script/UMG.WidgetBlueprintGeneratedClass");
  assert.equal(relay.classMeta["/Game/Fake/BP_FakePot.BP_FakePot_C"], "/Script/Engine.BlueprintGeneratedClass");
  assert.equal(relay.classMeta["/TestMod/Relay/BP_Relay.BP_Relay_C"], "/Script/Engine.BlueprintGeneratedClass");
});

test("Bad.ts: every marked error is reported at its line and column, and nothing else", () => {
  const text = readFileSync(`${projectDir}/src/Bad.ts`, "utf8").split(/\r?\n/);
  const expected: Array<{ line: number; code: string; col: number | undefined }> = [];
  text.forEach((raw, i) => {
    const m = /\/\/ ((?:ABFC\d{4}\s*)+)(?:@(.*))?$/.exec(raw);
    if (!m) return;
    const codes = m[1]!.trim().split(/\s+/);
    const snippet = m[2]?.trimEnd();
    for (const code of codes) expected.push({ line: i + 1, code, col: snippet !== undefined && codes.length === 1 ? raw.indexOf(snippet) + 1 : undefined });
  });
  assert.ok(expected.length >= 18, "Bad.ts carries one marker per error");

  const hir = buildHir(loaded, config, profile, [fileOf("Bad.ts")]);
  const actual = inFile([...loaded.diagnostics, ...hir.diagnostics], "src/Bad.ts");
  assert.ok(actual.every((d) => d.severity === "error"));
  const key = (line: number, code: string): string => `${line}:${code}`;
  assert.deepEqual(
    [...new Set(actual.map((d) => key(d.span!.line, d.code)))].sort(),
    [...new Set(expected.map((e) => key(e.line, e.code)))].sort(),
  );
  for (const e of expected) {
    if (e.col === undefined) continue;
    const hits = actual.filter((d) => d.code === e.code && d.span?.line === e.line);
    assert.ok(hits.some((d) => d.span?.col === e.col), `${e.code} on line ${e.line} should start at column ${e.col}, got ${hits.map((d) => d.span?.col).join(",")}`);
  }
  const codes = new Set(actual.map((d) => d.code));
  for (const c of ["ABFC2000", "ABFC2001", "ABFC2010", "ABFC2011", "ABFC2013", "ABFC2014", "ABFC2020", "ABFC2040", "ABFC2050", "ABFC2052", "ABFC2053", "ABFC2060", "ABFC2099", "ABFC3004"]) {
    assert.ok(codes.has(c), `Bad.ts should trigger ${c}`);
  }
});

test("TypeScript errors carry the [TSnnnn] prefix and a 1-based position", () => {
  const ts2322 = loaded.diagnostics.find((d) => d.span?.file === "src/Bad.ts" && d.message.startsWith("[TS2322]"));
  assert.ok(ts2322);
  assert.equal(ts2322.code, "ABFC2000");
  assert.ok(ts2322.span && ts2322.span.line >= 1 && ts2322.span.col >= 1 && ts2322.span.endCol > ts2322.span.col);
});

test("checkSubset reports one file's diagnostics", () => {
  const ds = checkSubset(loaded, fileOf("Bad.ts"), config, profile);
  assert.ok(ds.some((d) => d.code === "ABFC2000"));
  assert.ok(ds.some((d) => d.code === "ABFC2010"));
  assert.deepEqual(checkSubset(loaded, fileOf("Relay.ts"), config, profile), []);
});

test("compileTests: steps JSON", () => {
  const { cases, diagnostics } = compileTests(loaded, profile);
  assert.deepEqual(diagnostics, []);
  const view = cases.map((c) => ({ name: c.name, file: c.file, steps: c.steps.map((s) => (s.knownIssue === undefined ? s.step : { ...s.step, knownIssue: s.knownIssue })) }));
  const cls = "/TestMod/Relay/BP_Relay.BP_Relay_C";
  assert.deepEqual(view, [
    {
      name: "update target clears without a pot",
      file: "src/Relay.test.ts",
      steps: [
        { op: "spawn", class: cls, as: "relay" },
        { op: "call", target: "$relay", function: "UpdateTarget", args: [] },
        { op: "get", target: "$relay", property: "Visible", as: "_v0" },
        { op: "assert", value: "$_v0", equals: false },
        { op: "python", code: "result=str(ctx['relay'].get_editor_property('LastTarget'))", as: "last" },
        { op: "assert", value: "$last", equals: "None" },
        { op: "wait", seconds: 0.5 },
      ],
    },
    {
      name: "assertion forms",
      file: "src/Relay.test.ts",
      steps: [
        { op: "spawn", class: cls, as: "relay" },
        { op: "set", target: "$relay", property: "Visible", value: true },
        { op: "get", target: "$relay", property: "Visible", as: "vis" },
        { op: "assert", value: "$vis", truthy: true },
        { op: "get", target: "$relay", property: "LastName", as: "_v0" },
        { op: "assert", value: "$_v0", contains: "Row" },
        { op: "call", target: "$relay", function: "HideAll", args: [], as: "_v1" },
        { op: "assert", value: "$_v1", not_none: true, knownIssue: "pre-existing" },
        { op: "python", code: "result=1.0", as: "v", knownIssue: "wrong name in this build" },
        { op: "assert", value: "$v", approx: 1, tolerance: 0.01 },
        { op: "python", code: "result=None" },
      ],
    },
  ]);
  const first = cases[0]!;
  assert.equal(first.span.file, "src/Relay.test.ts");
  assert.equal(first.steps[1]!.span.line, 6);
  assert.equal(first.steps[3]!.span.line, 7);
});

test("compileTests: filter keeps matching names and files", () => {
  assert.equal(compileTests(loaded, profile, "assertion").cases.length, 1);
  assert.equal(compileTests(loaded, profile, "Relay.test").cases.length, 2);
  assert.equal(compileTests(loaded, profile, "nothing like this").cases.length, 0);
});
