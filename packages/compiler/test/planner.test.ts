import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unitStateHash } from "@abfc/ir";
import type { IrModule, Profile, T3dNode } from "@abfc/ir";
import { buildHir, loadProgram, lower, planBuild } from "../src/index.js";
import type { Manifest, ManifestUnit } from "../src/index.js";

const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;

function lowerFixture(): IrModule {
  const loaded = loadProgram(projectDir);
  const relay = loaded.files.classes.find((f) => f.fileName.endsWith("/Relay.ts"));
  assert.ok(relay);
  return lower(buildHir(loaded, { mod: "TestMod" }, profile, [relay]), profile);
}

const ir = lowerFixture();
const asset = ir.assets[0]!.path;
const unit = ir.assets[0]!.units[0]!;

function node(name: string, cls: string, head: string[], x = 0, y = 0): T3dNode {
  return { name, cls, graph: "EventGraph", head: [...head, `NodePosX=${x}`, `NodePosY=${y}`], pins: [] };
}

const EVENT = "/Script/BlueprintGraph.K2Node_CustomEvent";
const CALL = "/Script/BlueprintGraph.K2Node_CallFunction";

function snapshotOf(...nodes: T3dNode[]): Map<string, T3dNode> {
  return new Map(nodes.map((n) => [n.name, n]));
}

function manifestOf(...units: ManifestUnit[]): Manifest {
  return { asset, compiler: "test", profile: profile.id, units, variables: [] };
}

function mu(over: Partial<ManifestUnit> = {}): ManifestUnit {
  return {
    id: unit.id,
    graph: "EventGraph",
    irHash: "",
    assetHash: null,
    nodes: [],
    nodeIds: {},
    tag: null,
    stageSyncedAt: null,
    adopt: null,
    ...over,
  };
}

const stage = { syncedAt: "T1" };

test("a hand-made event of the same name with no manifest is ABFC5003", () => {
  const snapshot = snapshotOf(node("CE_1", EVENT, [`CustomFunctionName="UpdateTarget"`]));
  const r = planBuild(ir, {
    manifests: new Map([[asset, null]]),
    snapshots: new Map([[asset, snapshot]]),
    stage,
    handMadeUnits: new Map(),
  });
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["ABFC5003"]);
  assert.equal(r.diagnostics[0]!.severity, "error");
  assert.equal(r.diagnostics[0]!.asset, asset);
  assert.match(r.diagnostics[0]!.fix ?? "", /abfc adopt \/TestMod\/Relay\/BP_Relay UpdateTarget/);
  assert.deepEqual(r.plan.assets, []);

  // the explicit hand-made list works the same
  const r2 = planBuild(ir, {
    manifests: new Map(),
    snapshots: new Map([[asset, snapshotOf()]]),
    stage,
    handMadeUnits: new Map([[asset, ["UpdateTarget"]]]),
  });
  assert.deepEqual(r2.diagnostics.map((d) => d.code), ["ABFC5003"]);
});

test("a new unit in an empty asset is planned with origin (0, 600) and its temps", () => {
  const r = planBuild(ir, { manifests: new Map(), snapshots: new Map(), stage, handMadeUnits: new Map() });
  assert.deepEqual(r.diagnostics, []);
  assert.equal(r.plan.mod, "TestMod");
  const a = r.plan.assets[0]!;
  assert.equal(a.asset, asset);
  assert.deepEqual(a.units[0]!.removeNodes, []);
  assert.deepEqual(a.units[0]!.origin, [0, 600]);
  assert.deepEqual(a.variables.map((v) => v.name), ["abfc_UpdateTarget_t0", "abfc_UpdateTarget_i0"]);
});

test("pendingAdoption plans the unit with the adopted nodes removed; the origin sits below the remaining nodes", () => {
  const entry = node("CE_1", EVENT, [`CustomFunctionName="UpdateTarget"`], 10, 20);
  const call = node("CALL_1", CALL, [], 300, 20);
  const other = node("OTHER_1", CALL, [], -100, 50);
  const snapshot = snapshotOf(entry, call, other);
  const adopt = {
    entry: "CE_1",
    nodes: ["CE_1", "CALL_1"],
    hash: unitStateHash(snapshot, ["CE_1", "CALL_1"]),
    recordedAt: "2026-01-01T00:00:00Z",
    stageSyncedAt: null,
  };
  const r = planBuild(ir, {
    manifests: new Map([[asset, manifestOf(mu({ adopt }))]]),
    snapshots: new Map([[asset, snapshot]]),
    stage,
    handMadeUnits: new Map(),
    snapshotVariables: new Map([[asset, ["abfc_UpdateTarget_t0"]]]),
  });
  assert.deepEqual(r.diagnostics, []);
  const u = r.plan.assets[0]!.units[0]!;
  assert.deepEqual(u.removeNodes, ["CE_1", "CALL_1"]);
  assert.deepEqual(u.origin, [-100, 650]);
  // a temp the asset already declares is not declared again
  assert.deepEqual(r.plan.assets[0]!.variables.map((v) => v.name), ["abfc_UpdateTarget_i0"]);
  assert.deepEqual(r.plan.assets[0]!.graphNodes["EventGraph"]!.map((n) => n.name).sort(), ["CALL_1", "CE_1", "OTHER_1"]);
});

test("a changed adopted hand-made unit is ABFC5004 and nothing is planned", () => {
  const entry = node("CE_1", EVENT, [`CustomFunctionName="UpdateTarget"`]);
  const snapshot = snapshotOf(entry);
  const adopt = { entry: "CE_1", nodes: ["CE_1"], hash: "sha256:other", recordedAt: "2026-01-01T00:00:00Z", stageSyncedAt: null };
  const r = planBuild(ir, {
    manifests: new Map([[asset, manifestOf(mu({ adopt }))]]),
    snapshots: new Map([[asset, snapshot]]),
    stage,
    handMadeUnits: new Map(),
  });
  assert.deepEqual(r.diagnostics.map((d) => d.code), ["ABFC5004"]);
  assert.deepEqual(r.plan.assets, []);
});

test("clean and the same irHash: up to date, nothing planned", () => {
  const n1 = node("N1", CALL, []);
  const snapshot = snapshotOf(n1);
  const manifest = manifestOf(
    mu({ irHash: unit.hash, nodes: ["N1"], assetHash: unitStateHash(snapshot, ["N1"]), stageSyncedAt: "T1" }),
  );
  const r = planBuild(ir, {
    manifests: new Map([[asset, manifest]]),
    snapshots: new Map([[asset, snapshot]]),
    stage,
    handMadeUnits: new Map(),
  });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.plan.assets, []);
  assert.deepEqual(r.upToDate, [`${asset} ${unit.id}`]);
});

test("clean but a different irHash: replaced, the owned nodes are removed", () => {
  const n1 = node("N1", CALL, []);
  const snapshot = snapshotOf(n1);
  const manifest = manifestOf(
    mu({ irHash: "sha256:old", nodes: ["N1"], assetHash: unitStateHash(snapshot, ["N1"]), stageSyncedAt: "T1" }),
  );
  const r = planBuild(ir, {
    manifests: new Map([[asset, manifest]]),
    snapshots: new Map([[asset, snapshot]]),
    stage,
    handMadeUnits: new Map(),
  });
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.upToDate, []);
  assert.deepEqual(r.plan.assets[0]!.units[0]!.removeNodes, ["N1"]);
});

test("an edited owned unit is ABFC5001, a missing owned node ABFC5002", () => {
  const n1 = node("N1", CALL, []);
  const manifest = manifestOf(mu({ irHash: unit.hash, nodes: ["N1"], assetHash: "sha256:stale", stageSyncedAt: "T1" }));
  const edited = planBuild(ir, {
    manifests: new Map([[asset, manifest]]),
    snapshots: new Map([[asset, snapshotOf(n1)]]),
    stage,
    handMadeUnits: new Map(),
  });
  assert.deepEqual(edited.diagnostics.map((d) => d.code), ["ABFC5001"]);
  assert.deepEqual(edited.plan.assets, []);

  const missing = planBuild(ir, {
    manifests: new Map([[asset, manifest]]),
    snapshots: new Map([[asset, snapshotOf()]]),
    stage,
    handMadeUnits: new Map(),
  });
  assert.deepEqual(missing.diagnostics.map((d) => d.code), ["ABFC5002"]);
});
