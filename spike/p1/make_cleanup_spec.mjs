// Generates spike/out/p1/cleanup.spec.json: removes every node of BP_ReflectPins / BP_ReflectHost EventGraph
// (keeps the assets; they would otherwise hold ~1000 references to blocked/unlisted members during mod_audit).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseNodes } from "./t3dparse.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "out", "p1");
const names = (f) => [...parseNodes(readFileSync(join(out, f), "utf8")).values()].filter((n) => /K2Node_/.test(n.cls) && n.name.startsWith("K2Node_")).map((n) => n.name);
const spec = [
  { asset: "/goodsoupWagdD/_abfcSpike/BP_ReflectPins", graphs: [{ graph: "EventGraph", remove: names("r2-3.t3d") }] },
  { asset: "/goodsoupWagdD/_abfcSpike/BP_ReflectHost", graphs: [{ graph: "EventGraph", remove: names("final_0.t3d") }] },
];
writeFileSync(join(out, "cleanup.spec.json"), JSON.stringify(spec));
console.log(spec.map((s) => s.graphs[0].remove.length));
