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

// ---- Phase 2: class defaults, delegate owners, override units ----

const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const ir2 = (() => {
  const loaded = loadProgram(phase2Dir);
  const root = loaded.files.classes.find((f) => f.fileName.endsWith("/Director.ts"));
  assert.ok(root);
  return lower(buildHir(loaded, { mod: "TestMod" }, profile, [root]), profile);
})();
const asset2 = ir2.assets[0]!.path;
const units2 = ir2.assets[0]!.units;
const unitOf = (id: string) => units2.find((u) => u.id === id)!;

/** A manifest in which every unit of the Director asset is applied and clean against `snapshot`. */
function appliedManifest(snapshot: Map<string, T3dNode>, over: Partial<Manifest> = {}, hashes: Record<string, string> = {}): Manifest {
  const units = units2.map((u) => {
    const names = [`${u.name}_1`, `${u.name}_2`];
    return {
      id: u.id,
      graph: "EventGraph",
      irHash: hashes[u.id] ?? u.hash,
      assetHash: unitStateHash(snapshot, names),
      nodes: names,
      nodeIds: { ev0: names[0]! },
      tag: null,
      stageSyncedAt: "T1",
      adopt: null,
    } satisfies ManifestUnit;
  });
  return { asset: asset2, compiler: "test", profile: profile.id, units, variables: [], ...over };
}

function snapshot2(): Map<string, T3dNode> {
  return snapshotOf(...units2.flatMap((u) => [node(`${u.name}_1`, CALL, []), node(`${u.name}_2`, CALL, [])]));
}

const input2 = (m: Manifest, snapshot: Map<string, T3dNode>, st = stage) => ({
  manifests: new Map([[asset2, m]]),
  snapshots: new Map([[asset2, snapshot]]),
  stage: st,
  handMadeUnits: new Map<string, string[]>(),
});

test("class defaults are their own plan item, keyed by hash and by the stage they were applied to", () => {
  assert.deepEqual(ir2.assets[0]!.classDefaults, { bReplicates: "True", NetUpdateFrequency: "2.000000", TickInterval: "0.100000" });
  const snapshot = snapshot2();

  // never applied: a defaults-only plan (no units)
  const first = planBuild(ir2, input2(appliedManifest(snapshot), snapshot));
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.plan.assets.length, 1);
  assert.deepEqual(first.plan.assets[0]!.units, []);
  const d = first.plan.assets[0]!.defaults!;
  assert.equal(d.classPath, `${asset2}.BP_Director_C`);
  assert.deepEqual(d.values, ir2.assets[0]!.classDefaults);
  assert.match(d.hash, /^sha256:/);

  // applied with this hash on this stage: nothing to do
  const done = appliedManifest(snapshot, { classDefaultsHash: d.hash, classDefaultsStageSyncedAt: "T1" });
  assert.deepEqual(planBuild(ir2, input2(done, snapshot)).plan.assets, []);
  // the stage was resynced since (the defaults are gone): planned again
  const resynced = planBuild(ir2, input2(done, snapshot, { syncedAt: "T2" }));
  assert.ok(resynced.plan.assets.some((a) => a.defaults?.hash === d.hash));
  // a changed value or row changes the hash
  const other = appliedManifest(snapshot, { classDefaultsHash: "sha256:old", classDefaultsStageSyncedAt: "T1" });
  assert.equal(planBuild(ir2, input2(other, snapshot)).plan.assets[0]?.defaults?.hash, d.hash);
});

test("a changed delegate target replans the unit that takes its delegate; the reverse does not", () => {
  const snapshot = snapshot2();
  const hash = planBuild(ir2, input2(appliedManifest(snapshot), snapshot)).plan.assets[0]!.defaults!.hash;
  const base = { classDefaultsHash: hash, classDefaultsStageSyncedAt: "T1" };

  assert.deepEqual(unitOf("event:Start").crossWires?.map((w) => w.toUnit), ["event:Scan"]);

  const scanChanged = planBuild(ir2, input2(appliedManifest(snapshot, base, { "event:Scan": "sha256:old" }), snapshot));
  assert.deepEqual(scanChanged.diagnostics, []);
  assert.deepEqual(scanChanged.plan.assets[0]!.units.map((u) => u.unit.id).sort(), ["event:Scan", "event:Start"]);
  const start = scanChanged.plan.assets[0]!.units.find((u) => u.unit.id === "event:Start")!;
  assert.deepEqual(start.removeNodes, ["Start_1", "Start_2"]);
  assert.equal(scanChanged.plan.assets[0]!.entryNames, undefined, "both ends are in the plan, so no real name is needed");
  assert.ok(!scanChanged.upToDate.includes(`${asset2} event:Start`));

  const startChanged = planBuild(ir2, input2(appliedManifest(snapshot, base, { "event:Start": "sha256:old" }), snapshot));
  assert.deepEqual(startChanged.plan.assets[0]!.units.map((u) => u.unit.id), ["event:Start"]);
  assert.deepEqual(startChanged.plan.assets[0]!.entryNames, { "event:Scan": "Scan_1" }, "the untouched target is wired by its real entry name");
});

test("an override unit without a manifest: a hand-made enabled override is ABFC5003, a disabled default node is not", () => {
  const over = unitOf("override:ReceiveTick");
  const ev = (extra: string[]) => node("EV_1", "/Script/BlueprintGraph.K2Node_Event", [`EventReference=(MemberParent="x",MemberName="ReceiveTick")`, ...extra]);
  const run = (snapshot: Map<string, T3dNode>) =>
    planBuild(ir2, { manifests: new Map(), snapshots: new Map([[asset2, snapshot]]), stage, handMadeUnits: new Map() });
  const made = run(snapshotOf(ev([])));
  const hit = made.diagnostics.find((d) => d.code === "ABFC5003");
  assert.ok(hit && hit.span === over.origin);
  assert.match(hit.fix ?? "", /abfc adopt \S+ override:ReceiveTick/);
  const disabled = run(snapshotOf(ev(["EnabledState=Disabled"])));
  assert.ok(!disabled.diagnostics.some((d) => d.code === "ABFC5003"));
  assert.ok(disabled.plan.assets[0]!.units.some((u) => u.unit.id === "override:ReceiveTick"));
});

test("several pending adoptions in one asset are applied in one build: each removes its own adopted nodes", () => {
  const snapshot = snapshot2();
  const adopted = (id: string, nodes: string[]): ManifestUnit => ({
    id,
    graph: "EventGraph",
    irHash: "",
    assetHash: null,
    nodes: [],
    nodeIds: {},
    tag: null,
    stageSyncedAt: null,
    adopt: { entry: nodes[0]!, nodes, hash: unitStateHash(snapshot, nodes), recordedAt: "2026-01-01T00:00:00Z", stageSyncedAt: null },
  });
  const manifest: Manifest = {
    ...appliedManifest(snapshot),
    units: [adopted("event:Start", ["Start_1", "Start_2"]), adopted("event:Scan", ["Scan_1", "Scan_2"])],
  };
  const r = planBuild(ir2, input2(manifest, snapshot));
  const picked = r.plan.assets[0]!.units;
  assert.deepEqual(r.diagnostics.map((d) => d.code).filter((c) => c === "ABFC5003" || c === "ABFC5001"), []);
  assert.deepEqual(picked.find((u) => u.unit.id === "event:Start")!.removeNodes, ["Start_1", "Start_2"]);
  assert.deepEqual(picked.find((u) => u.unit.id === "event:Scan")!.removeNodes, ["Scan_1", "Scan_2"]);
});
