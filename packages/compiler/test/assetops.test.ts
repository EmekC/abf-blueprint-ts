import { test } from "node:test";
import assert from "node:assert/strict";
import { assetsNeedingRead, parentOps, planAssetOps } from "../src/index.js";
import type { HirClass, HirProgram, HirStruct, Manifest } from "../src/index.js";
import type { IrModule } from "@abfc/ir";

const span = (file: string) => ({ file, line: 3, col: 14, endLine: 3, endCol: 20 });
const ALL = { assetOps: ["rename", "delete", "reparent", "recreate"] };

const cls = (name: string, path: string, file: string, o: Partial<HirClass> = {}): HirClass =>
  ({ name, path, pathDerived: true, classPath: `${path}.${name}_C`, parent: "/Script/Engine.Actor", family: "actor", span: span(file), events: [], fields: [], manualUnits: [], hybrid: false, defaults: {}, ...o }) as HirClass;

const program = (classes: HirClass[], structs: HirStruct[] = []): HirProgram => ({ mod: "TestMod", classes, structs, classMeta: {}, diagnostics: [] });

const manifest = (asset: string, o: Partial<Manifest> = {}): Manifest => ({ asset, compiler: "t", profile: "p", units: [], variables: [], ...o });
const built = (asset: string, file: string, name: string, o: Partial<Manifest> = {}): Manifest => manifest(asset, { source: { file, class: name, derived: true }, ...o });

test("a renamed class (same file) is renamed from its only earlier asset", () => {
  const hir = program([cls("BP_New", "/TestMod/BP_New", "src/Thing.ts")]);
  const plan = planAssetOps(hir, [built("/TestMod/BP_Old", "src/Thing.ts", "BP_Old", { created: true })], "TestMod", ALL);
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.ops, [{ op: "rename", from: "/TestMod/BP_Old", to: "/TestMod/BP_New" }]);
  assert.deepEqual(plan.renames, [{ from: "/TestMod/BP_Old", to: "/TestMod/BP_New", class: "BP_New" }]);
  assert.deepEqual(plan.deletes, [], "a renamed asset is not deleted even though abfc created it");
});

test("a moved file (same class name) is renamed to the new folder", () => {
  const hir = program([cls("BP_Relay", "/TestMod/New/BP_Relay", "src/New/BP_Relay.ts")]);
  const plan = planAssetOps(hir, [built("/TestMod/Old/BP_Relay", "src/Old/BP_Relay.ts", "BP_Relay")], "TestMod", ALL);
  assert.deepEqual(plan.ops, [{ op: "rename", from: "/TestMod/Old/BP_Relay", to: "/TestMod/New/BP_Relay" }]);
});

test("a class with an explicit path: is renamed when that path changed", () => {
  const hir = program([cls("BP_Relay", "/TestMod/Chosen/BP_Relay", "src/Relay.ts", { pathDerived: false })]);
  const plan = planAssetOps(hir, [built("/TestMod/Old/BP_Relay", "src/Relay.ts", "BP_Relay")], "TestMod", ALL);
  assert.deepEqual(plan.ops, [{ op: "rename", from: "/TestMod/Old/BP_Relay", to: "/TestMod/Chosen/BP_Relay" }]);
});

test("several earlier assets are ambiguous: ABFC5012, no op, and none of them is deleted", () => {
  const hir = program([cls("BP_Relay", "/TestMod/New/BP_Relay", "src/New/BP_Relay.ts")]);
  const plan = planAssetOps(hir, [manifest("/TestMod/A/BP_Relay", { created: true }), manifest("/TestMod/B/BP_Relay", { created: true })], "TestMod", ALL);
  assert.deepEqual(plan.ops, []);
  assert.equal(plan.diagnostics.length, 1);
  assert.equal(plan.diagnostics[0]!.code, "ABFC5012");
  assert.equal(plan.diagnostics[0]!.severity, "error");
});

test("one earlier asset claimed by two classes is not renamed", () => {
  const file = "src/Both.ts";
  const hir = program([cls("BP_A", "/TestMod/BP_A", file), cls("BP_B", "/TestMod/BP_B", file)]);
  const plan = planAssetOps(hir, [built("/TestMod/BP_Old", file, "BP_Old", { created: true })], "TestMod", ALL);
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.diagnostics.map((d) => d.code), ["ABFC5012", "ABFC5012"]);
});

test("without the rename capability a move is today's ABFC5012 error and nothing is deleted", () => {
  const hir = program([cls("BP_Relay", "/TestMod/New/BP_Relay", "src/New/BP_Relay.ts")]);
  const plan = planAssetOps(hir, [built("/TestMod/Old/BP_Relay", "src/Old/BP_Relay.ts", "BP_Relay", { created: true })], "TestMod", { assetOps: [] });
  assert.deepEqual(plan.ops, []);
  assert.equal(plan.diagnostics[0]!.severity, "error");
  assert.equal(plan.diagnostics[0]!.code, "ABFC5012");
  assert.match(plan.diagnostics[0]!.message, /abfc will not create a second asset/);
  // ... and an explicit path: never raised it
  const explicit = planAssetOps(program([cls("BP_Relay", "/TestMod/X/BP_Relay", "src/R.ts", { pathDerived: false })]), [built("/TestMod/Old/BP_Relay", "src/R.ts", "BP_Relay")], "TestMod", { assetOps: [] });
  assert.deepEqual(explicit.diagnostics, []);
});

test("a struct that moved stays an ABFC5012 error even with the capability", () => {
  const s = { name: "S_Top", path: "/TestMod/New/S_Top", pathDerived: true, objectPath: "/TestMod/New/S_Top.S_Top", fields: [], span: span("src/New/S_Top.ts") } as HirStruct;
  const plan = planAssetOps(program([], [s]), [built("/TestMod/S_Top", "src/S_Top.ts", "S_Top", { structFieldsHash: "h", created: true })], "TestMod", ALL);
  assert.deepEqual(plan.ops, []);
  assert.equal(plan.diagnostics[0]!.code, "ABFC5012");
});

test("a class that left the TS is deleted only when abfc created its asset", () => {
  const hir = program([cls("BP_Keep", "/TestMod/BP_Keep", "src/Keep.ts")]);
  const plan = planAssetOps(
    hir,
    [
      manifest("/TestMod/BP_Keep", { created: true }),
      built("/TestMod/BP_Gone", "src/Gone.ts", "BP_Gone", { created: true }),
      built("/TestMod/BP_Handmade", "src/Handmade.ts", "BP_Handmade"),
      manifest("/TestMod/BP_Old", { created: false }),
      manifest("/OtherMod/BP_Foreign", { created: true }),
      manifest("/TestMod/BP_Tomb", { created: true, deleted: true }),
    ],
    "TestMod",
    ALL,
  );
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.deletes, ["/TestMod/BP_Gone"]);
  assert.deepEqual(plan.ops, [{ op: "delete", asset: "/TestMod/BP_Gone" }]);
});

test("a struct manifest is never deleted", () => {
  const plan = planAssetOps(program([]), [manifest("/TestMod/S_Gone", { created: true, structFieldsHash: "h" })], "TestMod", ALL);
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.ops, []);
});

test("the class-manager row abfc wrote goes with the asset, rows still used by another class stay", () => {
  const user = cls("BP_User", "/TestMod/BP_User", "src/User.ts", { director: { row: "Shared", asset: "/TestMod/DataTables/DT_ClassManager/Shared" } });
  const plan = planAssetOps(
    program([user]),
    [
      manifest("/TestMod/BP_Gone", { created: true, directorRow: "/TestMod/DataTables/DT_ClassManager/Own" }),
      manifest("/TestMod/BP_Gone2", { created: true, directorRow: "/TestMod/DataTables/DT_ClassManager/Shared" }),
    ],
    "TestMod",
    ALL,
  );
  assert.deepEqual(plan.ops, [
    { op: "delete", asset: "/TestMod/DataTables/DT_ClassManager/Own" },
    { op: "delete", asset: "/TestMod/BP_Gone" },
    { op: "delete", asset: "/TestMod/BP_Gone2" },
  ]);
  assert.deepEqual(plan.rowDeletes, [{ asset: "/TestMod/BP_Gone", row: "/TestMod/DataTables/DT_ClassManager/Own" }]);
});

test("without the delete capability nothing is deleted (the build retires the units, ABFC5010)", () => {
  const plan = planAssetOps(program([]), [manifest("/TestMod/BP_Gone", { created: true })], "TestMod", { assetOps: ["rename", "reparent"] });
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.deletes, []);
});

test("renames come before deletes", () => {
  const hir = program([cls("BP_New", "/TestMod/BP_New", "src/New.ts")]);
  const plan = planAssetOps(hir, [built("/TestMod/BP_Gone", "src/Gone.ts", "BP_Gone", { created: true }), built("/TestMod/BP_Old", "src/New.ts", "BP_Old")], "TestMod", ALL);
  assert.deepEqual(plan.ops.map((o) => o.op), ["rename", "delete"]);
});

const own = { name: "BP_C", family: "component" as const, span: span("src/C.ts") };

test("parentOps: unchanged, unknown or equal up to case is nothing to do", () => {
  const m = manifest("/TestMod/BP_C", { parent: "/Script/Engine.Actor", parentFamily: "actor", created: true });
  assert.equal(parentOps("/TestMod/BP_C", m, null, { ...own, family: "actor", parent: "/script/engine.actor" }, ALL).action, "none");
  assert.equal(parentOps("/TestMod/BP_C", manifest("/TestMod/BP_C"), null, { ...own, parent: "/Script/Engine.Actor" }, ALL).action, "none", "no recorded or read parent");
});

test("parentOps: a parent in the same family is a reparent (also for a manifest without a recorded parent, from the export)", () => {
  const m = manifest("/TestMod/BP_C", { parent: "/Script/Engine.Actor", parentFamily: "actor" });
  const p = parentOps("/TestMod/BP_C", m, null, { ...own, family: "actor", parent: "/Script/Engine.Pawn" }, ALL);
  assert.equal(p.action, "reparent");
  assert.deepEqual(p.ops, [{ op: "reparent", asset: "/TestMod/BP_C", parent: "/Script/Engine.Pawn" }]);
  const old = parentOps("/TestMod/BP_C", manifest("/TestMod/BP_C"), "/Script/Engine.Actor", { ...own, family: "actor", parent: "/Script/Engine.Pawn" }, ALL);
  assert.equal(old.action, "reparent");
  assert.equal(old.from, "/Script/Engine.Actor");
});

test("parentOps: another family recreates an asset abfc created", () => {
  const m = manifest("/TestMod/BP_C", { parent: "/Script/Engine.Actor", parentFamily: "actor", created: true });
  const p = parentOps("/TestMod/BP_C", m, null, { ...own, parent: "/Script/Engine.ActorComponent" }, ALL);
  assert.equal(p.action, "recreate");
  assert.deepEqual(p.ops, [{ op: "recreate", asset: "/TestMod/BP_C" }]);
  // the caller learned from the backend that the families differ
  const forced = parentOps("/TestMod/BP_C", manifest("/TestMod/BP_C", { parent: "/Script/Engine.Actor", created: true }), null, { ...own, parent: "/Script/Engine.ActorComponent" }, ALL, { crossFamily: true });
  assert.equal(forced.action, "recreate");
});

test("parentOps: a recreate of an asset abfc did not create is refused (ABFC2048)", () => {
  const m = manifest("/TestMod/BP_C", { parent: "/Script/Engine.Actor", parentFamily: "actor" });
  const p = parentOps("/TestMod/BP_C", m, null, { ...own, parent: "/Script/Engine.ActorComponent" }, ALL);
  assert.equal(p.action, "error");
  assert.deepEqual(p.ops, []);
  assert.equal(p.diagnostics[0]!.code, "ABFC2048");
  assert.match(p.diagnostics[0]!.message, /not created by abfc/);
  assert.deepEqual(p.diagnostics[0]!.span, own.span);
});

test("parentOps: without the capability a parent change is ABFC2048", () => {
  const m = manifest("/TestMod/BP_C", { parent: "/Script/Engine.Actor", parentFamily: "actor", created: true });
  const same = parentOps("/TestMod/BP_C", m, null, { ...own, family: "actor", parent: "/Script/Engine.Pawn" }, { assetOps: [] });
  assert.equal(same.action, "error");
  assert.equal(same.diagnostics[0]!.code, "ABFC2048");
  assert.match(same.diagnostics[0]!.message, /cannot change the parent/);
  const cross = parentOps("/TestMod/BP_C", m, null, { ...own, parent: "/Script/Engine.ActorComponent" }, { assetOps: ["reparent"] });
  assert.equal(cross.action, "error");
  assert.equal(cross.diagnostics[0]!.code, "ABFC2048");
});

const irWith = (parent: string): IrModule =>
  ({ assets: [{ path: "/TestMod/BP_C", create: { kind: "Blueprint", parent }, variables: [], units: [] }], classMeta: {} }) as unknown as IrModule;

test("assetsNeedingRead reads an asset whose parent differs from the recorded one", () => {
  const stage = { syncedAt: "s1" } as never;
  const same = new Map<string, Manifest | null>([["/TestMod/BP_C", manifest("/TestMod/BP_C", { parent: "/Script/Engine.Actor" })]]);
  assert.equal(assetsNeedingRead(irWith("/Script/Engine.Actor"), { manifests: same, stage }).size, 0);
  assert.equal(assetsNeedingRead(irWith("/script/engine.actor"), { manifests: same, stage }).size, 0, "case-insensitive");
  assert.deepEqual([...assetsNeedingRead(irWith("/Script/Engine.ActorComponent"), { manifests: same, stage })], ["/TestMod/BP_C"]);
  // a manifest without a recorded parent does not force a read by itself
  const old = new Map<string, Manifest | null>([["/TestMod/BP_C", manifest("/TestMod/BP_C")]]);
  assert.equal(assetsNeedingRead(irWith("/Script/Engine.ActorComponent"), { manifests: old, stage }).size, 0);
});
