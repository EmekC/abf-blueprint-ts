import { test } from "node:test";
import assert from "node:assert/strict";
import { movedClassDiagnostics } from "../src/index.js";
import type { HirClass, HirProgram, HirStruct, Manifest } from "../src/index.js";

const span = (file: string) => ({ file, line: 3, col: 14, endLine: 3, endCol: 20 });

const cls = (name: string, path: string, file: string, pathDerived = true): HirClass =>
  ({ name, path, pathDerived, classPath: `${path}.${name}_C`, parent: "/Script/Engine.Actor", span: span(file), events: [], fields: [], manualUnits: [], defaults: {} }) as HirClass;

const program = (classes: HirClass[], structs: HirStruct[] = []): HirProgram => ({ mod: "TestMod", classes, structs, classMeta: {}, diagnostics: [] });

const manifest = (asset: string, source?: Manifest["source"]): Manifest => ({
  asset,
  compiler: "t",
  profile: "p",
  units: [],
  variables: [],
  ...(source !== undefined ? { source } : {}),
});

test("a moved file is found through source.class", () => {
  const hir = program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts")]);
  const ds = movedClassDiagnostics(hir, [manifest("/TestMod/Old/MyRelay", { file: "src/Old/MyRelay.ts", class: "MyRelay", derived: true })], "TestMod");
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.code, "ABFC5012");
  assert.equal(ds[0]!.severity, "error");
  assert.equal(
    ds[0]!.message,
    "MyRelay was built as /TestMod/Old/MyRelay (from src/Old/MyRelay.ts) but its file now gives /TestMod/New/MyRelay. abfc will not create a second asset or retire the first one.",
  );
  assert.deepEqual(ds[0]!.data, { keepPath: "Old/MyRelay", recorded: "/TestMod/Old/MyRelay" });
  assert.match(ds[0]!.fix ?? "", /path: "Old\/MyRelay"/);
  assert.deepEqual(ds[0]!.span, span("src/New/MyRelay.ts"));
});

test("a renamed class is found through source.file", () => {
  const hir = program([cls("Renamed", "/TestMod/Relays/Renamed", "src/Relays/Thing.ts")]);
  const ds = movedClassDiagnostics(hir, [manifest("/TestMod/Relays/Thing", { file: "src/Relays/Thing.ts", class: "Thing", derived: true })], "TestMod");
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.data?.keepPath, "Relays/Thing");
});

test("a manifest without source is matched by the last path segment", () => {
  const hir = program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts")]);
  const ds = movedClassDiagnostics(hir, [manifest("/TestMod/Old/MyRelay")], "TestMod");
  assert.equal(ds.length, 1);
  assert.doesNotMatch(ds[0]!.message, /\(from /);
  assert.equal(ds[0]!.data?.keepPath, "Old/MyRelay");
  assert.equal(movedClassDiagnostics(hir, [manifest("/TestMod/Old/Other")], "TestMod").length, 0, "another name is no match");
});

test("a struct that moved is found too", () => {
  const s = { name: "S_Top", path: "/TestMod/New/S_Top", pathDerived: true, objectPath: "/TestMod/New/S_Top.S_Top", fields: [], span: span("src/New/S_Top.ts") } as HirStruct;
  const ds = movedClassDiagnostics(program([], [s]), [manifest("/TestMod/S_Top", { file: "src/S_Top.ts", class: "S_Top", derived: true })], "TestMod");
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.data?.keepPath, "S_Top");
});

test("a derived path that differs only in case from a manifest is no move", () => {
  const hir = program([cls("MyRelay", "/TestMod/relays/MyRelay", "src/relays/MyRelay.ts")]);
  assert.deepEqual(movedClassDiagnostics(hir, [manifest("/TestMod/Relays/MyRelay", { file: "src/Relays/MyRelay.ts", class: "MyRelay", derived: true })], "TestMod"), []);
});

test("a class with an explicit path is skipped", () => {
  const hir = program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts", false)]);
  assert.deepEqual(movedClassDiagnostics(hir, [manifest("/TestMod/Old/MyRelay", { file: "src/Old/MyRelay.ts", class: "MyRelay", derived: true })], "TestMod"), []);
});

test("a manifest that another class still resolves to, or of another mod, is not an orphan", () => {
  const hir = program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts"), cls("Other", "/TestMod/Old/MyRelay", "src/Old/Other.ts", false)]);
  assert.deepEqual(movedClassDiagnostics(hir, [manifest("/TestMod/Old/MyRelay", { file: "src/Old/MyRelay.ts", class: "MyRelay", derived: true })], "TestMod"), []);
  assert.deepEqual(movedClassDiagnostics(program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts")]), [manifest("/OtherMod/Old/MyRelay")], "TestMod"), []);
});

test("several matching manifests give one error that lists them and has no quick-fix data", () => {
  const hir = program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts")]);
  const ds = movedClassDiagnostics(hir, [manifest("/TestMod/A/MyRelay"), manifest("/TestMod/B/MyRelay")], "TestMod");
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.code, "ABFC5012");
  assert.match(ds[0]!.message, /\/TestMod\/A\/MyRelay, \/TestMod\/B\/MyRelay/);
  assert.equal(ds[0]!.data, undefined);
});

test("a class whose derived path has a manifest is fine", () => {
  const hir = program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts")]);
  assert.deepEqual(movedClassDiagnostics(hir, [manifest("/TestMod/New/MyRelay"), manifest("/TestMod/Old/MyRelay")], "TestMod"), []);
});
