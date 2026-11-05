// Generates spike/p4/loop.spec.json (counter loop with back-edge, function + event graph).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const MATH = "/Script/Engine.KismetMathLibrary";
const nodes = (p, cnt, idx) => [
  { id: p + "si", k: "set", name: idx, set: { [idx]: "0" } },
  { id: p + "sc", k: "set", name: cnt, set: { [cnt]: "0" } },
  { id: p + "gi", k: "get", name: idx },
  { id: p + "lt", k: "call", class: MATH, function: "Less_IntInt", set: { B: "10" } },
  { id: p + "br", k: "branch" },
  { id: p + "gc", k: "get", name: cnt },
  { id: p + "ac", k: "call", class: MATH, function: "Add_IntInt", set: { B: "1" } },
  { id: p + "sc2", k: "set", name: cnt },
  { id: p + "gi2", k: "get", name: idx },
  { id: p + "ai", k: "call", class: MATH, function: "Add_IntInt", set: { B: "1" } },
  { id: p + "si2", k: "set", name: idx },
];
const wires = (p, cnt, idx, start) => [
  [start, p + "si.execute"],
  [p + "si.then", p + "sc.execute"],
  [p + "sc.then", p + "br.execute"],
  [p + "gi." + idx, p + "lt.A"],
  [p + "lt.ReturnValue", p + "br.Condition"],
  [p + "br.then", p + "sc2.execute"],
  [p + "gc." + cnt, p + "ac.A"],
  [p + "ac.ReturnValue", p + "sc2." + cnt],
  [p + "sc2.then", p + "si2.execute"],
  [p + "gi2." + idx, p + "ai.A"],
  [p + "ai.ReturnValue", p + "si2." + idx],
  [p + "si2.then", p + "br.execute"], // back-edge
];
const fnNodes = [...nodes("", "Count", "I"), { id: "gc3", k: "get", name: "Count" }];
const fnWires = [...wires("", "Count", "I", "entry.then"), ["br.else", "result.execute"], ["gc3.Count", "result.Result"]];
const evNodes = [{ id: "ev", k: "event", name: "CountEv" }, ...nodes("e", "CountE", "IE")];
const evWires = wires("e", "CountE", "IE", "ev.then");
const spec = [{
  asset: "/goodsoupWagdD/_abfcSpike/BP_LoopProbe",
  create: { class: "Blueprint", parent: "/Script/Engine.Actor", if_missing: true },
  variables: ["Count", "I", "CountE", "IE"].map((name) => ({ name, type: "int", default: "0" })),
  functions: [{ name: "CountFn", inputs: [], outputs: [{ name: "Result", type: "int" }], nodes: fnNodes, wires: fnWires }],
  graphs: [{ graph: "EventGraph", add: evNodes, wires: evWires }],
}];
const out = join(dirname(fileURLToPath(import.meta.url)), "loop.spec.json");
writeFileSync(out, JSON.stringify(spec, null, 2));
console.log("wrote", out);
