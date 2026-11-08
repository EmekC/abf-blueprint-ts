import { test } from "node:test";
import assert from "node:assert/strict";
import { matchOrphans, movedClassDiagnostics } from "../src/index.js";
import type { HirClass, HirProgram, HirStruct, Manifest } from "../src/index.js";

const span = (file: string) => ({ file, line: 3, col: 14, endLine: 3, endCol: 20 });

const cls = (name: string, path: string, file: string, pathDerived = true): HirClass =>
  ({ name, path, pathDerived, classPath: `${path}.${name}_C`, parent: "/Script/Engine.Actor", family: "actor", span: span(file), events: [], fields: [], manualUnits: [], hybrid: false, defaults: {} }) as HirClass;

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
  const ds = movedClassDiagnostics(hir, [manifest("/TestMod/Old/MyRelay", { file: "src/Old/MyRelay.ts", class: "MyRelay", derived: true })], "TestMod", { singleMatch: "error" });
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

test("two classes in one file that both moved each match only their own manifest", () => {
  const file = "src/P4Tally.ts";
  const s = { name: "S_P4Entry", path: "/TestMod/S_P4Entry", pathDerived: true, objectPath: "/TestMod/S_P4Entry.S_P4Entry", fields: [], span: span(file) } as HirStruct;
  const hir = program([cls("BP_P4Tally", "/TestMod/BP_P4Tally", file)], [s]);
  const ds = movedClassDiagnostics(
    hir,
    [
      manifest("/TestMod/Phase4/BP_P4Tally", { file, class: "BP_P4Tally", derived: true }),
      manifest("/TestMod/Phase4/S_P4Entry", { file, class: "S_P4Entry", derived: true }),
    ],
    "TestMod",
  );
  assert.equal(ds.length, 2);
  for (const d of ds) assert.equal(d.code, "ABFC5012");
  assert.deepEqual(ds[0]!.data, { keepPath: "Phase4/BP_P4Tally", recorded: "/TestMod/Phase4/BP_P4Tally" });
  assert.match(ds[0]!.fix ?? "", /path: "Phase4\/BP_P4Tally"/);
  assert.deepEqual(ds[1]!.data, { keepPath: "Phase4/S_P4Entry", recorded: "/TestMod/Phase4/S_P4Entry" });
  assert.match(ds[1]!.fix ?? "", /path: "Phase4\/S_P4Entry"/);
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

test("without a backend (check, language server) one match of a class is a warning that says the build renames it; a struct stays an error", () => {
  const hir = program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts")]);
  const ds = movedClassDiagnostics(hir, [manifest("/TestMod/Old/MyRelay", { file: "src/Old/MyRelay.ts", class: "MyRelay", derived: true })], "TestMod");
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.severity, "warning");
  assert.equal(ds[0]!.message, "MyRelay was built as /TestMod/Old/MyRelay (from src/Old/MyRelay.ts); the next abfc build renames the asset to /TestMod/New/MyRelay (backend 2.6.0).");
  assert.deepEqual(ds[0]!.data, { keepPath: "Old/MyRelay", recorded: "/TestMod/Old/MyRelay" }, "the keep-path quick fix is still offered");
  const s = { name: "S_Top", path: "/TestMod/New/S_Top", pathDerived: true, objectPath: "/TestMod/New/S_Top.S_Top", fields: [], span: span("src/New/S_Top.ts") } as HirStruct;
  const st = movedClassDiagnostics(program([], [s]), [manifest("/TestMod/S_Top", { file: "src/S_Top.ts", class: "S_Top", derived: true })], "TestMod");
  assert.equal(st[0]!.severity, "error");
  // several matches are an error whatever the mode
  const several = movedClassDiagnostics(hir, [manifest("/TestMod/A/MyRelay"), manifest("/TestMod/B/MyRelay")], "TestMod");
  assert.equal(several[0]!.severity, "error");
});

test("matchOrphans: tombstones are no orphans, struct manifests do not match classes, explicit paths only on request", () => {
  const hir = program([cls("MyRelay", "/TestMod/New/MyRelay", "src/New/MyRelay.ts", false)]);
  const old = manifest("/TestMod/Old/MyRelay", { file: "src/Old/MyRelay.ts", class: "MyRelay", derived: true });
  assert.equal(matchOrphans(hir, [old], "TestMod").matches.length, 0, "explicit path: skipped by default");
  assert.equal(matchOrphans(hir, [old], "TestMod", { explicit: true }).matches.length, 1);
  assert.equal(matchOrphans(hir, [{ ...old, deleted: true }], "TestMod", { explicit: true }).matches.length, 0, "a tombstone is gone");
  assert.equal(matchOrphans(hir, [{ ...old, structFieldsHash: "h" }], "TestMod", { explicit: true }).matches.length, 0, "a struct manifest is no class");
});
