// Builds spike/out/p5/raw-graph.spec.json: replaces graph "Probe" of BP_RawNodeProbe with the wired graph text taken from
// out/p5/wired-attempt1.t3d (nodes wired by the graphs edit) in which the wildcard pins of Array_Length / Array_Get are
// resolved to int (what the editor writes after a type propagation). Same text-level approach as bp_apply raw kind "graph".
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const ls = readFileSync(join(here, "..", "out", "p5", "wired-attempt1.t3d"), "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
const out = [];
for (let k = 0; k < ls.length; k++) {
  if (ls[k].startsWith("   Begin Object") && ls[k].includes('Name="Probe"')) {
    let j = k + 1;
    while (j < ls.length && !ls[j].startsWith("   End Object")) j++;
    out.push(...ls.slice(k + 1, j));
  }
}
let n = 0;
const text = out.map((l) => l.replace(/ ExportPath="[^"]*"/, "")).map((l) => {
  if (/CustomProperties Pin \(.*PinName="(TargetArray|Array|Output)",/.test(l) && l.includes('PinType.PinCategory="wildcard"')) {
    n++;
    return l.replace('PinType.PinCategory="wildcard"', 'PinType.PinCategory="int"');
  }
  return l;
}).join("\n");
if (n !== 3) throw new Error("expected 3 wildcard pins, patched " + n);
writeFileSync(join(here, "..", "out", "p5", "raw-graph.spec.json"), JSON.stringify([{ asset: "/goodsoupWagdD/_abfcSpike/BP_RawNodeProbe", raw: [{ kind: "graph", graph: "Probe", text }] }], null, 2));
console.log("patched", n, "lines:", out.length);
