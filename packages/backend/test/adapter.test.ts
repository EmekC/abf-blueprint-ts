import { test } from "node:test";
import assert from "node:assert/strict";
import { AbfcError } from "@abfc/env";
import type { IrNode } from "@abfc/ir";
import { applyPlan, effectivePinTypes, renderMainSpec, renderTagSpec, specNodeId } from "../src/index.js";
import type { BpNodeSpec } from "../src/index.js";
import { FakeBackend, caps, ir, nodeIdsFor, planOf, profile, realName, result } from "./fixture.js";

const plan = planOf(ir);
const asset = plan.assets[0]!;
const unit = asset.units[0]!.unit;

const withPinTypes = (nodes: BpNodeSpec[]): BpNodeSpec[] => nodes.filter((n) => n.pin_types !== undefined);

function mainNodes(pin: boolean, cast: boolean): BpNodeSpec[] {
  return renderMainSpec(asset, caps(pin, cast), profile).graphs![0]!.add;
}

test("the fixture has the expected shape", () => {
  assert.equal(unit.nodes.length, 52);
  assert.equal(unit.wires.length, 74);
});

test("no pin_types when the backend lacks native pin types", () => {
  assert.equal(withPinTypes(mainNodes(false, false)).length, 0);
  assert.equal(withPinTypes(mainNodes(false, true)).length, 0);
});

test("pin types without cast_object_pin: on the 5 wildcard nodes, casts carry Object", () => {
  const nodes = withPinTypes(mainNodes(true, false));
  assert.equal(nodes.length, 5);
  const casts = nodes.filter((n) => n.k === "cast");
  assert.equal(casts.length, 2);
  for (const c of casts) assert.deepEqual(c.pin_types, { Object: profile.castObjectPinType });
});

test("pin types with cast_object_pin: only the array length nodes and the array item", () => {
  const nodes = withPinTypes(mainNodes(true, true));
  assert.equal(nodes.length, 3);
  assert.equal(nodes.filter((n) => n.k === "cast").length, 0);
  assert.equal(nodes.filter((n) => Object.keys(n.pin_types!).join() === "TargetArray").length, 2);
  assert.equal(nodes.filter((n) => Object.keys(n.pin_types!).join() === "Array,Output").length, 1);
});

test("effectivePinTypes refuses what the backend refuses", () => {
  const base: IrNode = { id: "x0", t3d: { class: profile.nodeClasses.callFunction, props: [] }, pos: [0, 0], origin: unit.origin };
  const c = caps(true, true);
  const code = (n: IrNode): string | undefined => {
    try {
      effectivePinTypes(n, c, profile);
      return undefined;
    } catch (e) {
      assert.ok(e instanceof AbfcError);
      assert.equal(e.exitCode, 2);
      return e.diagnostic.code;
    }
  };
  assert.equal(code({ ...base, pinTypes: { A: "exec" } }), "ABFC4010");
  assert.equal(code({ ...base, pinTypes: { A: "array:exec" } }), "ABFC4010");
  assert.equal(code({ ...base, pinTypes: { A: "map:name:int" } }), "ABFC4010");
  assert.equal(code({ ...base, pinTypes: { A: "set:int" } }), "ABFC4010");
  assert.equal(code({ ...base, sem: { k: "self" }, pinTypes: { A: "int" } }), "ABFC4010");
  assert.equal(code({ ...base, pinTypes: { A: "int" } }), undefined);
  assert.deepEqual(effectivePinTypes({ ...base, pinTypes: { A: "array:int" } }, c, profile), { A: "array:int" });
});

test("variables carry flags 8196", () => {
  const spec = renderMainSpec(asset, caps(true, true), profile);
  assert.deepEqual(spec.variables!.map((v) => v.name), ["abfc_UpdateTarget_t0", "abfc_UpdateTarget_i0"]);
  for (const v of spec.variables!) assert.equal(v.flags, 8196);
});

test("ids are unique and dot-free, wires use them, positions are offset by the origin", () => {
  const spec = renderMainSpec(asset, caps(true, true), profile);
  assert.equal(spec.graphs!.length, 1);
  const g = spec.graphs![0]!;
  assert.equal(g.graph, "EventGraph");
  assert.deepEqual(g.remove, []);
  const ids = g.add.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(!id.includes("."), id);
  assert.ok(ids.includes("UpdateTarget_cast0"));
  assert.equal(specNodeId(unit, "cast0"), "UpdateTarget_cast0");
  assert.equal(g.wires!.length, unit.wires.length);
  for (const [from, to] of g.wires!) {
    for (const end of [from, to]) assert.ok(ids.includes(end.slice(0, end.indexOf("."))), end);
  }
  unit.nodes.forEach((n, i) => assert.deepEqual(g.add[i]!.pos, [100 + n.pos[0], 200 + n.pos[1]], n.id));
});

test("sem nodes use native kinds, others are raw nodes", () => {
  const nodes = mainNodes(true, true);
  const cast = nodes.find((n) => n.k === "cast")!;
  assert.equal(typeof cast.target, "string");
  const raw = nodes.filter((n) => n.k === "node");
  for (const r of raw) {
    assert.equal(typeof r.class, "string");
    assert.ok(Array.isArray(r.props));
  }
  assert.ok(nodes.some((n) => n.k === "event" && n.name === "UpdateTarget"));
});

test("removeNodes are passed through to the graph", () => {
  const p = planOf(ir);
  p.assets[0]!.units[0]!.removeNodes = ["K2Node_A", "K2Node_B"];
  assert.deepEqual(renderMainSpec(p.assets[0]!, caps(true, true), profile).graphs![0]!.remove, ["K2Node_A", "K2Node_B"]);
});

test("tag spec: one comment box per unit, above and left of the origin", () => {
  const spec = renderTagSpec(asset, asset.units, profile);
  assert.equal(spec.asset, asset.asset);
  const add = spec.graphs![0]!.add;
  assert.equal(add.length, 1);
  assert.equal(add[0]!.id, "cmt_UpdateTarget");
  assert.equal(add[0]!.class, profile.nodeClasses.comment);
  assert.deepEqual(add[0]!.pos, [50, 80]);
  assert.match(add[0]!.props![0]!, /^NodeComment="abfc:owned unit=event:UpdateTarget src=.+ ir=[0-9a-f]{8} - generated by abfc, edit the \.ts file"$/);
  assert.match(add[0]!.props![1]!, /^NodeWidth=\d+$/);
  assert.match(add[0]!.props![2]!, /^NodeHeight=\d+$/);
});

test("applyPlan on the native route: one main call, then the tag pass; node ids and tag names are mapped", async () => {
  const c = caps(true, true);
  const ids = nodeIdsFor(plan, c);
  const backend = new FakeBackend((call) =>
    call.label === "main"
      ? result({ assets: [{ asset: asset.asset, node_ids: ids }] })
      : result({ assets: [{ asset: asset.asset, node_ids: { "graph:0": { cmt_UpdateTarget: "EdGraphNode_Comment_0" } } }] }),
  );
  const timings: string[] = [];
  const out = await applyPlan(backend, plan, c, profile, { cacheDir: "cache", record: (s) => timings.push(s) });
  assert.equal(out.ok, true);
  assert.deepEqual(backend.calls.map((x) => x.label), ["main", "tags"]);
  assert.equal(backend.calls[0]!.specs.length, 1);
  assert.deepEqual(timings, ["apply.main", "apply.tags"]);
  const a = out.perAsset[0]!;
  assert.equal(a.nodeIds["event:UpdateTarget/cast0"], realName("UpdateTarget_cast0"));
  assert.equal(Object.keys(a.nodeIds).length, unit.nodes.length);
  assert.equal(a.tagName, "EdGraphNode_Comment_0");
  assert.deepEqual(a.tagNames, { "event:UpdateTarget": "EdGraphNode_Comment_0" });
  assert.equal(a.tagWarning, undefined);
});

test("applyPlan: a failing tag pass is a warning, a failing main pass skips the tags", async () => {
  const c = caps(true, true);
  const ids = nodeIdsFor(plan, c);
  const tagFails = new FakeBackend((call) =>
    call.label === "main" ? result({ assets: [{ asset: asset.asset, node_ids: ids }] }) : result({ ok: false, error: "nope" }),
  );
  const a = await applyPlan(tagFails, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(a.ok, true);
  assert.equal(a.perAsset[0]!.tagWarning?.code, "ABFC5101");
  assert.equal(a.perAsset[0]!.tagName, null);

  const mainFails = new FakeBackend(() =>
    result({ ok: false, rolledBack: true, compile: { errors: [{ asset: asset.asset, message: "Bad pin", node: realName("UpdateTarget_br0") }], warnings: [] } }),
  );
  const b = await applyPlan(mainFails, plan, c, profile, { cacheDir: "cache", record: () => {} });
  assert.equal(b.ok, false);
  assert.deepEqual(mainFails.calls.map((x) => x.label), ["main"]);
  assert.equal(b.perAsset[0]!.compile.length, 1);
  assert.equal(b.perAsset[0]!.compile[0]!.message, "Bad pin");
});

test("applyPlan with no assets does nothing", async () => {
  const backend = new FakeBackend(() => result());
  const out = await applyPlan(backend, { mod: "TestMod", assets: [] }, caps(true, true), profile, { cacheDir: "cache", record: () => {} });
  assert.deepEqual(out, { ok: true, perAsset: [] });
  assert.equal(backend.calls.length, 0);
});
