// Builds spike/out/p6/map-raw.spec.json: BP_MapProbe with the AddAndFind graph text taken from out/p6/attempt1-final_0.t3d
// (the rolled-back first apply) in which the wildcard pins of Map_Add / Map_Find are resolved (Key name, Value int, TargetMap map name->int).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "out", "p6", "attempt1-final_0.t3d");
const GRAPH = "AddAndFind";
const ls = readFileSync(src, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
const out = [];
for (let k = 0; k < ls.length; k++) {
  if (ls[k].startsWith("   Begin Object") && ls[k].includes(`Name="${GRAPH}"`)) {
    let j = k + 1;
    while (j < ls.length && !ls[j].startsWith("   End Object")) j++;
    out.push(...ls.slice(k + 1, j));
  }
}
const W = 'PinType.PinCategory="wildcard",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None';
const patch = {
  K2Node_CallFunction_9001: { TargetMap: "map", Key: "name", Value: "int" },
  K2Node_CallFunction_9002: { TargetMap: "map", Key: "name", Value: "int" },
};
let cur = null, n = 0;
const text = out.map((l) => l.replace(/ ExportPath="[^"]*"/, "")).map((l) => {
  const m = /^\s*Begin Object (?:Class=\S+ )?Name="([^"]+)"/.exec(l);
  if (m) cur = m[1];
  const pm = /CustomProperties Pin \(.*?PinName="([^"]+)",/.exec(l);
  if (pm && cur && patch[cur] && patch[cur][pm[1]] && l.includes('PinType.PinCategory="wildcard"')) {
    const t = patch[cur][pm[1]];
    n++;
    if (t === "map") return l.replace(W, 'PinType.PinCategory="name",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None').replace('PinType.PinValueType=(TerminalCategory="wildcard")', 'PinType.PinValueType=(TerminalCategory="int")');
    return l.replace(W, `PinType.PinCategory="${t}",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None`);
  }
  return l;
}).join("\n");
if (n !== 6) throw new Error("expected 6 wildcard pins, patched " + n);
const base = JSON.parse(readFileSync(join(here, "map.spec.json"), "utf8"))[0];
const fn = { name: "AddAndFind", inputs: base.functions[0].inputs, outputs: base.functions[0].outputs, nodes: [], wires: [["entry.then", "result.execute"]] };
writeFileSync(join(here, "..", "out", "p6", "map-raw.spec.json"), JSON.stringify([{ asset: base.asset, create: base.create, variables: base.variables, functions: [fn], raw: [{ kind: "graph", graph: GRAPH, text }] }], null, 2));
console.log("patched", n, "lines:", out.length);
