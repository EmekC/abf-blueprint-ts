import { test } from "node:test";
import assert from "node:assert/strict";
import { AbfcError } from "@abfc/env";
import { applyPlan } from "../src/index.js";
import { FakeBackend, caps, ir, nodeIdsFor, planOf, profile, realName, result, syntheticFinal, tmpRun, writeFinal } from "./fixture.js";

const plan = planOf(ir);
const asset = plan.assets[0]!.asset;
const count = (text: string, needle: string): number => text.split(needle).length - 1;

const undetermined = (n: number): Array<{ asset: string; message: string }> =>
  Array.from({ length: n }, (_, i) => ({ asset, message: `The type of Pin${i} is undetermined. Connect something to determine the type.` }));

/** Phase A fails with `n` undetermined-pin errors; phase B (and the tag pass) succeed. */
function scenario(pinTypesCaps: ReturnType<typeof caps>, n: number): { backend: FakeBackend; run: string } {
  const run = writeFinal(plan, pinTypesCaps);
  const ids = nodeIdsFor(plan, pinTypesCaps);
  const backend = new FakeBackend((call) => {
    if (call.label === "main-a") {
      return result({ ok: false, rolledBack: true, run, assets: [{ asset, node_ids: ids }], compile: { errors: undetermined(n), warnings: [] } });
    }
    if (call.label === "main-b") return result({ run });
    return result({ run: tmpRun(), assets: [{ asset, node_ids: { "graph:0": { cmt_UpdateTarget: "EdGraphNode_Comment_0" } } }] });
  });
  return { backend, run };
}

test("phase A undetermined errors -> phase B applies the patched graph raw (6 pins)", async () => {
  const c = caps(false, false);
  const { backend } = scenario(c, 5);
  const timings: string[] = [];
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: (s) => timings.push(s) });
  assert.equal(out.ok, true);
  assert.deepEqual(backend.calls.map((x) => x.label), ["main-a", "main-b", "tags"]);
  assert.deepEqual(timings, ["apply.phaseA", "apply.phaseB", "apply.tags"]);

  const a = backend.calls[0]!.specs[0]!;
  assert.ok(a.graphs, "phase A sends the node spec");
  assert.equal(a.graphs[0].add.filter((n: any) => n.pin_types !== undefined).length, 0);

  const b = backend.calls[1]!.specs[0]!;
  assert.equal(b.asset, asset);
  assert.equal(b.graphs, undefined);
  assert.equal(b.raw.length, 1);
  assert.equal(b.raw[0].kind, "graph");
  assert.equal(b.raw[0].graph, "EventGraph");
  assert.equal(b.variables.length, 2);
  const synthetic = syntheticFinal(plan, c);
  assert.equal(count(synthetic, 'PinCategory="wildcard"'), 6);
  assert.equal(count(b.raw[0].text, 'PinCategory="wildcard"'), 0);
  assert.equal(count(b.raw[0].text, "ContainerType=Array"), 3);
  assert.ok(!b.raw[0].text.includes("ExportPath"));

  // node ids are the ones of phase A
  assert.equal(out.perAsset[0]!.nodeIds["event:UpdateTarget/cast0"], realName("UpdateTarget_cast0"));
  assert.equal(out.perAsset[0]!.tagName, "EdGraphNode_Comment_0");
});

test("with cast_object_pin but no pin_types: 4 pins are patched, the casts are left alone", async () => {
  const c = caps(false, true);
  const { backend } = scenario(c, 3);
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.ok, true);
  const b = backend.calls[1]!.specs[0]!;
  assert.equal(count(syntheticFinal(plan, c), 'PinCategory="wildcard"'), 4);
  assert.equal(count(b.raw[0].text, 'PinCategory="wildcard"'), 0);
  // the two cast Object pins keep the type the backend gave them
  assert.equal(count(b.raw[0].text, "Class'/Script/CoreUObject.Object'"), 2);
});

test("a non-wildcard error in phase A stops before phase B and is returned", async () => {
  const c = caps(false, false);
  const run = writeFinal(plan, c);
  const backend = new FakeBackend(() =>
    result({
      ok: false,
      rolledBack: true,
      run,
      assets: [{ asset, node_ids: nodeIdsFor(plan, c) }],
      compile: {
        errors: [...undetermined(2), { asset, message: "Variable Foo not found", node: realName("UpdateTarget_br0") }],
        warnings: [],
      },
    }),
  );
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.ok, false);
  assert.deepEqual(backend.calls.map((x) => x.label), ["main-a"]);
  assert.deepEqual(out.perAsset[0]!.compile.map((e) => e.message), ["Variable Foo not found"]);
  assert.equal(out.perAsset[0]!.compile[0]!.node, realName("UpdateTarget_br0"));
});

test("a missing final_0.t3d is ABFC4003", async () => {
  const c = caps(false, false);
  const backend = new FakeBackend(() =>
    result({
      ok: false,
      rolledBack: true,
      run: tmpRun(),
      assets: [{ asset, node_ids: nodeIdsFor(plan, c) }],
      compile: { errors: undetermined(5), warnings: [] },
    }),
  );
  await assert.rejects(
    applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: () => {} }),
    (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC4003",
  );
  assert.equal(backend.calls.length, 1);
});

test("a phase B failure is returned with its errors", async () => {
  const c = caps(false, false);
  const run = writeFinal(plan, c);
  const backend = new FakeBackend((call) =>
    call.label === "main-a"
      ? result({ ok: false, rolledBack: true, run, assets: [{ asset, node_ids: nodeIdsFor(plan, c) }], compile: { errors: undetermined(5), warnings: [] } })
      : result({ ok: false, rolledBack: true, run, compile: { errors: [{ asset, message: "Still broken" }], warnings: [] } }),
  );
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.ok, false);
  assert.deepEqual(backend.calls.map((x) => x.label), ["main-a", "main-b"]);
  assert.deepEqual(out.perAsset[0]!.compile.map((e) => e.message), ["Still broken"]);
});

test("native pin types never take the fallback route", async () => {
  const c = caps(true, true);
  const backend = new FakeBackend((call) =>
    call.label === "main" ? result({ ok: false, compile: { errors: undetermined(1), warnings: [] } }) : result(),
  );
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(out.ok, false);
  assert.deepEqual(backend.calls.map((x) => x.label), ["main"]);
});
