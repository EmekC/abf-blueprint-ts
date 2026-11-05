// Builds spike/out/p3/raw-eventgraph.spec.json: replaces graph "EventGraph" of BP_SoupInfoRelay with the graph text taken from
// out/p3/attempt1-final_0.t3d (the rolled-back first apply) in which the wildcard pins are resolved to concrete types
// (what the editor writes after type propagation). Same text-level approach as spike/p5/make_raw_graph_spec.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ?? join(here, "..", "out", "p3", "attempt1-final_0.t3d");
const dst = process.argv[3] ?? join(here, "..", "out", "p3", "raw-eventgraph.spec.json");
const ls = readFileSync(src, "utf8").split("\n").map((l) => l.replace(/\r$/, ""));
const out = [];
for (let k = 0; k < ls.length; k++) {
  if (ls[k].startsWith("   Begin Object") && ls[k].includes('Name="EventGraph"')) {
    let j = k + 1;
    while (j < ls.length && !ls[j].startsWith("   End Object")) j++;
    out.push(...ls.slice(k + 1, j));
  }
}
const OBJ = "/Script/CoreUObject.Class'/Script/CoreUObject.Object'";
const BUFF = "/Script/CoreUObject.ScriptStruct'/Script/AbioticFactor.BuffDebuffRowHandle'";
const WBP = "/Script/UMG.WidgetBlueprintGeneratedClass'/goodsoupWagdD/SoupInfo/WBP_SoupInfo.WBP_SoupInfo_C'";
// node name (real, from apply node_ids) -> pin name -> [category, subCategoryObject]
const patch = {
  K2Node_DynamicCast_9001: { Object: ["object", OBJ] },
  K2Node_DynamicCast_9002: { Object: ["object", OBJ] },
  K2Node_CallArrayFunction_9001: { TargetArray: ["struct", BUFF] },
  K2Node_CallArrayFunction_9002: { TargetArray: ["object", WBP] },
  K2Node_GetArrayItem_9001: { Array: ["object", WBP], Output: ["object", WBP] },
};
let cur = null, n = 0;
const text = out.map((l) => l.replace(/ ExportPath="[^"]*"/, "")).map((l) => {
  const m = /^\s*Begin Object (?:Class=\S+ )?Name="([^"]+)"/.exec(l);
  if (m) cur = m[1];
  const pm = /CustomProperties Pin \(.*?PinName="([^"]+)",/.exec(l);
  if (pm && cur && patch[cur] && patch[cur][pm[1]] && l.includes('PinType.PinCategory="wildcard"')) {
    const [cat, obj] = patch[cur][pm[1]];
    n++;
    return l.replace('PinType.PinCategory="wildcard",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None',
      `PinType.PinCategory="${cat}",PinType.PinSubCategory="",PinType.PinSubCategoryObject="${obj}"`);
  }
  return l;
}).join("\n");
if (n !== 6) throw new Error("expected 6 wildcard pins, patched " + n);
// the temp variables must be declared by the same spec (the raw graph only carries the nodes)
const variables = JSON.parse(readFileSync(join(here, "..", "out", "p3", "apply.spec.json"), "utf8"))[0].variables;
writeFileSync(dst, JSON.stringify([{ asset: "/goodsoupWagdD/SoupInfo/BP_SoupInfoRelay", variables, raw: [{ kind: "graph", graph: "EventGraph", text }] }], null, 2));
console.log("patched", n, "lines:", out.length);
