import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256, unitHash } from "../src/index.js";
import type { IrUnit, Span } from "../src/index.js";

const span: Span = { file: "a.ts", line: 1, col: 1, endLine: 1, endCol: 2 };

function unit(): IrUnit {
  return {
    id: "event:Go", kind: "event", name: "Go", graph: "EventGraph",
    signature: { inputs: [{ name: "X", type: "int" }], outputs: [] },
    locals: [],
    nodes: [
      { id: "ev0", t3d: { class: "/Script/Fake.Event", props: ["A=1"] }, pos: [0, 0], origin: span },
      { id: "call1", t3d: { class: "/Script/Fake.Call", props: ["B=2"] }, pinDefaults: { In: "3" }, pos: [100, 0], origin: span },
    ],
    wires: [["ev0.then", "call1.execute"]],
    origin: span,
    hash: "",
  };
}

test("canonicalJson sorts keys, keeps array order, drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, 1], c: undefined, d: null }), '{"a":[2,1],"b":1,"d":null}');
  assert.equal(canonicalJson({ z: { y: 1, x: "s" } }), '{"z":{"x":"s","y":1}}');
});

test("sha256 is hex", () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("unitHash ignores pos and origin", () => {
  const a = unit();
  const b = unit();
  b.nodes[1]!.pos = [500, 500];
  b.nodes[0]!.origin = { ...span, line: 99 };
  b.origin = { ...span, line: 7 };
  b.hash = "ignored";
  assert.equal(unitHash(a), unitHash(b));
  assert.match(unitHash(a), /^sha256:[0-9a-f]{64}$/);
});

test("unitHash changes when a wire, a default or the signature changes", () => {
  const base = unitHash(unit());
  const w = unit();
  w.wires = [["ev0.then", "call1.other"]];
  assert.notEqual(unitHash(w), base);
  const d = unit();
  d.nodes[1]!.pinDefaults = { In: "4" };
  assert.notEqual(unitHash(d), base);
  const s = unit();
  s.signature.inputs = [{ name: "X", type: "int64" }];
  assert.notEqual(unitHash(s), base);
});
