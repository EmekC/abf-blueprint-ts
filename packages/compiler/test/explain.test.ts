import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrModule, IrNode, Profile, Span } from "@abfc/ir";
import { checkProject, describeIrNode, irNodesAt, loadProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;

const span = (line: number, col: number, endLine: number, endCol: number): Span => ({ file: "src/A.ts", line, col, endLine, endCol });
const node = (id: string, origin: Span, over: Partial<IrNode> = {}): IrNode => ({
  id,
  t3d: { class: "/Script/BlueprintGraph.K2Node_CallFunction", props: [] },
  pos: [0, 0],
  origin,
  ...over,
});

test("describeIrNode names nodes by their semantic tag", () => {
  assert.equal(describeIrNode(node("b", span(1, 1, 1, 2), { sem: { k: "branch" } })), "Branch");
  assert.equal(describeIrNode(node("s", span(1, 1, 1, 2), { sem: { k: "sequence" } })), "Sequence");
  assert.equal(describeIrNode(node("c", span(1, 1, 1, 2), { sem: { k: "cast", target: "/Script/Engine.Pawn" } })), "Cast To Pawn");
  assert.equal(describeIrNode(node("g", span(1, 1, 1, 2), { sem: { k: "get", name: "Count" } })), "Get Count");
  assert.equal(describeIrNode(node("t", span(1, 1, 1, 2), { sem: { k: "set", name: "Count" } })), "Set Count");
  assert.equal(describeIrNode(node("e", span(1, 1, 1, 2), { sem: { k: "event", name: "Go" } })), "Custom Event Go");
  assert.equal(describeIrNode(node("o", span(1, 1, 1, 2), { sem: { k: "override", class: "/Script/Engine.Actor", function: "ReceiveBeginPlay" } })), "Event ReceiveBeginPlay");
  assert.equal(describeIrNode(node("x", span(1, 1, 1, 2), { sem: { k: "self" } })), "Self");
  assert.equal(describeIrNode(node("p", span(1, 1, 1, 2), { sem: { k: "spawn" } })), "Spawn Actor from Class");
  assert.equal(describeIrNode(node("w", span(1, 1, 1, 2), { sem: { k: "create_widget" } })), "Create Widget");
  assert.equal(describeIrNode(node("d", span(1, 1, 1, 2), { sem: { k: "call_dispatcher", name: "OnDone" } })), "Call OnDone");
  assert.equal(describeIrNode(node("y", span(1, 1, 1, 2), { sem: { k: "bind_dispatcher", name: "OnDone" } })), "Bind Event to OnDone");
});

test("describeIrNode: calls, pure calls and nodes without a tag", () => {
  const call = node("c", span(1, 1, 1, 2), { sem: { k: "call", class: "/Script/Engine.KismetMathLibrary", function: "Divide_IntInt" } });
  assert.equal(describeIrNode(call), "Call KismetMathLibrary.Divide_IntInt");
  const pure = node("c", span(1, 1, 1, 2), {
    sem: { k: "call", class: "/Script/Engine.KismetMathLibrary", function: "Add_IntInt" },
    t3d: { class: "/Script/BlueprintGraph.K2Node_CallFunction", props: ["bIsPureFunc=True", 'FunctionReference=(MemberName="Add_IntInt")'] },
  });
  assert.equal(describeIrNode(pure), "Call KismetMathLibrary.Add_IntInt (pure)");
  assert.equal(describeIrNode(node("c", span(1, 1, 1, 2), { sem: { k: "call", function: "Pick" } })), "Call Self.Pick");
  const raw = node("r", span(1, 1, 1, 2), { t3d: { class: "/Script/BlueprintGraph.K2Node_Timeline", props: ['MemberName="Fade"'] } });
  assert.equal(describeIrNode(raw), "Timeline Fade");
  assert.equal(describeIrNode(node("r", span(1, 1, 1, 2), { t3d: { class: "/Script/BlueprintGraph.K2Node_Knot", props: [] } })), "Knot");
});

function irWith(nodes: IrNode[]): IrModule {
  return {
    irVersion: 1,
    profile: "p",
    mod: "TestMod",
    classMeta: {},
    assets: [
      {
        path: "/TestMod/A",
        variables: [],
        units: [
          {
            id: "event:Go", kind: "event", name: "Go", graph: "EventGraph", signature: { inputs: [], outputs: [] },
            locals: [], nodes, wires: [], origin: span(1, 1, 9, 2), hash: "h",
          },
        ],
      },
    ],
  };
}

test("irNodesAt: smallest span first, then emission order; falls back to the line", () => {
  const big = node("big", span(2, 3, 4, 10));
  const small = node("small", span(3, 5, 3, 12));
  const twin = node("twin", span(3, 5, 3, 12));
  const other = node("other", span(6, 3, 6, 20));
  const ir = irWith([big, small, twin, other]);
  assert.deepEqual(irNodesAt(ir, "src/A.ts", 3, 6).map((n) => n.id), ["small", "twin", "big"]);
  // end column is exclusive, start inclusive
  assert.deepEqual(irNodesAt(ir, "src/A.ts", 3, 12).map((n) => n.id), ["big"]);
  assert.deepEqual(irNodesAt(ir, "src/A.ts", 3, 5).map((n) => n.id), ["small", "twin", "big"]);
  // no node contains (6, 1): the nodes written on line 6
  assert.deepEqual(irNodesAt(ir, "src/A.ts", 6, 1).map((n) => n.id), ["other"]);
  assert.deepEqual(irNodesAt(ir, "src/A.ts", 8, 1), []);
  assert.deepEqual(irNodesAt(ir, "src/Other.ts", 3, 6), []);
});

test("irNodesAt and describeIrNode on a lowered fixture", () => {
  const dir = mkdtempSync(join(here, "explain-"));
  let res;
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    res = checkProject(loadProgram(dir), { mod: "TestMod" }, profile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(res.ir);
  const all = res.ir.assets.flatMap((a) => a.units.flatMap((u) => u.nodes));
  const branch = all.find((n) => n.sem?.k === "branch");
  assert.ok(branch, "the fixture lowers an if/ternary to a Branch");
  assert.equal(describeIrNode(branch), "Branch");
  const hits = irNodesAt(res.ir, branch.origin.file, branch.origin.line, branch.origin.col);
  assert.ok(hits.some((n) => n.id === branch.id));
  assert.ok(hits.map(describeIrNode).includes("Branch"));
});
