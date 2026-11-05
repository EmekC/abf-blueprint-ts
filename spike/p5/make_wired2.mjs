// Builds spike/out/p5/raw-wired2.spec.json: same as raw-wired.spec.json but the Array_Length / Array_Get nodes carry
// their own Pin lines (copied from the discovery export) with wildcard resolved to int, so ReconstructNode keeps them.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, "raw-wired.spec.json"), "utf8"));
const lines = readFileSync(join(here, "..", "out", "p5", "discover.t3d"), "utf8").split(/\r?\n/);
function pinLines(node) {
  const s = lines.findIndex((l) => l.includes(`Begin Object Name="${node}"`));
  const out = [];
  for (let i = s + 1; !/^\s*End Object/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*(CustomProperties Pin \(.*\))\s*$/);
    if (m) out.push(m[1].replace('PinType.PinCategory="wildcard"', 'PinType.PinCategory="int"').replace(/LinkedTo=\([^)]*\),/, ""));
  }
  return out;
}
const g = spec[0].graphs[0];
for (const n of g.add) {
  if (n.id === "len") n.props.push(...pinLines("K2Node_CallArrayFunction_9001"));
  if (n.id === "gai") n.props.push(...pinLines("K2Node_GetArrayItem_9001"));
}
writeFileSync(join(here, "..", "out", "p5", "raw-wired2.spec.json"), JSON.stringify(spec, null, 2));
console.log("ok");
