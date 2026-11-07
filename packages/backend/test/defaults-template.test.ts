import { test } from "node:test";
import assert from "node:assert/strict";
import { AbfcError } from "@abfc/env";
import type { ApplyPlan } from "@abfc/ir";
import { applyPlan, renderDefaultsCode, renderDefaultsSpec } from "../src/index.js";
import { FakeBackend, caps, nodeIdsFor, planOf, profile, ir, result } from "./fixture.js";

const CLASS = "/TestMod/Relay/BP_Director.BP_Director_C";

test("the template output for a set of defaults is fixed", () => {
  const code = renderDefaultsCode(CLASS, {
    bReplicates: "True",
    NetUpdateFrequency: "2.000000",
    TickInterval: "0.100000",
  });
  assert.equal(
    code,
    [
      'cdo = unreal.get_default_object(unreal.load_class(None, "/TestMod/Relay/BP_Director.BP_Director_C"))',
      'cdo.set_editor_property("net_update_frequency", 2.000000)',
      "cdo.set_actor_tick_interval(0.100000)",
      'cdo.set_editor_property("replicates", True)',
      "",
    ].join("\n"),
  );
});

test("the class manager row check is a read-only load plus an ABFC2070 print", () => {
  const code = renderDefaultsCode(CLASS, {}, "/TestMod/DataTables/ClassManager/Row_Director");
  assert.match(code, /^cdo = unreal\.get_default_object/);
  assert.match(code, /row_asset = unreal\.load_asset\("\/TestMod\/DataTables\/ClassManager\/Row_Director"\)/);
  assert.match(code, /print\("ABFC2070 class manager row \/TestMod\/DataTables\/ClassManager\/Row_Director does not reference \/TestMod\/Relay\/BP_Director"\)/);
  assert.doesNotMatch(code, /save|delete|set_editor_property\("row"/);
});

test("values outside the validated map never reach the template (ABFC2061)", () => {
  const codeOf = (e: unknown): string => (e as AbfcError).diagnostic?.code ?? String(e);
  for (const [values, row] of [
    [{ bReplicates: "True)\nimport os" }, undefined],
    [{ NetUpdateFrequency: "2" }, undefined],
    [{ NetUpdateFrequency: "__import__('os')" }, undefined],
    [{ Unknown: "True" }, undefined],
    [{ bStartWithTickEnabled: "False" }, undefined], // unverified: not in the validated map
    [{}, "/TestMod/Row\"; import os"],
  ] as Array<[Record<string, string>, string | undefined]>) {
    assert.throws(() => renderDefaultsCode(CLASS, values, row), (e) => codeOf(e) === "ABFC2061");
  }
  assert.throws(() => renderDefaultsCode('/TestMod/X.X_C"))\nimport os', {}), (e) => codeOf(e) === "ABFC2061");
});

function plannedWithDefaults(): ApplyPlan {
  const plan = planOf(ir);
  const a = plan.assets[0]!;
  return {
    ...plan,
    assets: [{ ...a, defaults: { classPath: CLASS, values: { bReplicates: "True" }, hash: "sha256:x", classManagerRow: "/TestMod/DataTables/ClassManager/Row_Director" } }],
  };
}

test("pass 5 sends one python spec per asset after the tag pass; ABFC2070 lines become warnings", async () => {
  const plan = plannedWithDefaults();
  const c = caps(true, true);
  const ids = nodeIdsFor(plan, c);
  const asset = plan.assets[0]!;
  const backend = new FakeBackend((call) => {
    if (call.label === "main") return result({ assets: [{ asset: asset.asset, node_ids: ids }] });
    if (call.label === "defaults") return result({ logTail: "x\nABFC2070 class manager row is wrong\n" });
    return result({ assets: [{ asset: asset.asset, node_ids: { "graph:0": { cmt_UpdateTarget: "EdGraphNode_Comment_0" } } }] });
  });
  const timings: string[] = [];
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: (s) => timings.push(s) });
  assert.equal(out.ok, true);
  assert.deepEqual(backend.calls.map((x) => x.label), ["main", "tags", "defaults"]);
  assert.deepEqual(backend.calls[2]!.specs, [renderDefaultsSpec(asset, c)]);
  const sent = backend.calls[2]!.specs[0]! as { raw: Array<{ kind: string }> };
  assert.equal(sent.raw[0]?.kind, "python");
  assert.deepEqual(timings, ["apply.main", "apply.tags", "apply.defaults"]);
  assert.equal(out.perAsset[0]!.defaultsApplied, true);
  assert.equal(out.perAsset[0]!.defaultsWarnings[0]!.code, "ABFC2070");
});

test("a failed pass 5 is a warning (ABFC5102), not applied, and the build still succeeds", async () => {
  const plan = plannedWithDefaults();
  const c = caps(true, true);
  const ids = nodeIdsFor(plan, c);
  const backend = new FakeBackend((call) =>
    call.label === "defaults" ? result({ ok: false, error: "no cdo" }) : result({ assets: [{ asset: plan.assets[0]!.asset, node_ids: ids }] }),
  );
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.ok, true);
  assert.equal(out.perAsset[0]!.defaultsApplied, false);
  assert.equal(out.perAsset[0]!.defaultsWarnings[0]!.code, "ABFC5102");
});

test("an asset that only carries defaults takes part in pass 5 only", async () => {
  const plan = plannedWithDefaults();
  const only: ApplyPlan = { ...plan, assets: [{ ...plan.assets[0]!, units: [], variables: [], graphNodes: {} }] };
  const backend = new FakeBackend(() => result());
  const out = await applyPlan(backend, only, caps(true, true), profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.ok, true);
  assert.deepEqual(backend.calls.map((x) => x.label), ["defaults"]);
  assert.equal(out.perAsset[0]!.defaultsApplied, true);
});

function plannedWithDirector(): ApplyPlan {
  const plan = planOf(ir);
  const a = plan.assets[0]!;
  const row = "/TestMod/DataTables/DT_ClassManager/EntityDirector_Test";
  return { ...plan, assets: [{ ...a, units: [], variables: [], graphNodes: {}, defaults: { classPath: CLASS, values: {}, hash: "sha256:d", director: { asset: row, classPath: CLASS } } }] };
}

test("with the classManagerRows capability the defaults spec carries class_manager_row and the template does not verify the row", () => {
  const plan = plannedWithDirector();
  const on = renderDefaultsSpec(plan.assets[0]!, { ...caps(true, true), classManagerRows: true });
  assert.deepEqual(on.class_manager_row, { asset_path: "/TestMod/DataTables/DT_ClassManager/EntityDirector_Test", class_path: CLASS });
  assert.doesNotMatch((on.raw![0] as { code: string }).code, /row_asset/);
  const off = renderDefaultsSpec(plan.assets[0]!, caps(true, true));
  assert.equal(off.class_manager_row, undefined);
  assert.match((off.raw![0] as { code: string }).code, /row_asset = unreal\.load_asset\("\/TestMod\/DataTables\/DT_ClassManager\/EntityDirector_Test"\)/);
});

test("pass 5 reads the rows of the bp_apply result; a missing row is ABFC5102 and not applied", async () => {
  const plan = plannedWithDirector();
  const c = { ...caps(true, true), classManagerRows: true };
  const rowAsset = "/TestMod/DataTables/DT_ClassManager/EntityDirector_Test";
  const ok = await applyPlan(new FakeBackend(() => result({ rows: [{ asset: rowAsset, created: true, changed: true }] })), plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.deepEqual(ok.perAsset[0]!.directorRow, { asset: rowAsset, created: true, changed: true });
  assert.equal(ok.perAsset[0]!.defaultsApplied, true);
  assert.deepEqual(ok.perAsset[0]!.defaultsWarnings, []);
  const missing = await applyPlan(new FakeBackend(() => result()), plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(missing.perAsset[0]!.defaultsApplied, false);
  assert.equal(missing.perAsset[0]!.directorRow, undefined);
  assert.equal(missing.perAsset[0]!.defaultsWarnings[0]!.code, "ABFC5102");
});

test("without the capability a director row is verified and ABFC2077 is reported once", async () => {
  const plan = plannedWithDirector();
  const out = await applyPlan(new FakeBackend(() => result()), plan, caps(true, true), profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.perAsset[0]!.defaultsApplied, true);
  assert.equal(out.perAsset[0]!.directorRow, undefined);
  assert.deepEqual(out.perAsset[0]!.defaultsWarnings.map((d) => d.code), ["ABFC2077"]);
});
