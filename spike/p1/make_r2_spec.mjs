// Generates spike/out/p1/r2.chunk<N>.spec.json (+ r2.map.json, props.json) for R2 pin materialization.
// Input: spike/out/p1/reflect_enum.json (R1) and spike/out/p1/final_0.t3d (R1 export holding the GetClassDefaults nodes; pass node names as argv: playerNode potNode).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "out", "p1");
const [playerNode, potNode] = process.argv.slice(2);
const PLAYER = "/Game/Blueprints/Characters/Abiotic_PlayerCharacter.Abiotic_PlayerCharacter_C";
const POT = "/Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup.Deployed_PotOfSoup_C";
const refl = JSON.parse(readFileSync(join(outDir, "reflect_enum.json"), "utf8"));
const pins = JSON.parse(execFileSync("node", [join(here, "..", "p5", "pins.mjs"), join(outDir, "final_0.t3d"), playerNode, potNode], { encoding: "utf8", maxBuffer: 1 << 28 }));
const props = {
  [PLAYER]: pins[playerNode].filter((p) => p.Direction === "out").map((p) => p.PinName),
  [POT]: pins[potNode].filter((p) => p.Direction === "out").map((p) => p.PinName),
};
writeFileSync(join(outDir, "props.json"), JSON.stringify(props, null, 1));
const SKIP = (f) => f.startsWith("ExecuteUbergraph_") || f.endsWith("__DelegateSignature");
const members = []; // {id, kind, class, name}
let n = 0;
const skipped = [];
for (const c of [PLAYER, POT]) {
  for (const f of refl.classes[c].functions) {
    if (SKIP(f)) { skipped.push(c + " " + f); continue; }
    members.push({ id: "f" + n++, k: "call", class: c, function: f });
  }
}
const extra = [
  ["/Script/Engine.Controller", ["K2_GetPawn", "IsLocalController"]],
  ["/Script/AbioticFactor.GlobalItemHandleFunctionLibrary", ["GetGlobalItemRow", "Conv_GlobalItemToName"]],
  ["/Script/Engine.KismetSystemLibrary", ["IsValid"]],
  ["/Script/Engine.KismetMathLibrary", ["EqualEqual_ObjectObject", "EqualEqual_NameName", "Not_PreBool", "EqualEqual_DoubleDouble", "EqualEqual_IntInt", "BooleanAND", "Less_IntInt", "Add_IntInt"]],
  ["/Script/Engine.KismetArrayLibrary", ["Array_Length", "Array_Get"]],
];
for (const [c, fs] of extra) for (const f of fs) members.push({ id: "f" + n++, k: "call", class: c, function: f });
let pn = 0;
for (const c of [PLAYER, POT]) for (const p of props[c]) members.push({ id: "p" + pn++, k: "get", class: c, name: p });
const map = {};
for (const m of members) map[m.id] = m.k === "call" ? { kind: "call", class: m.class, member: m.function } : { kind: "get", class: m.class, member: m.name };
writeFileSync(join(outDir, "r2.map.json"), JSON.stringify({ skipped, map }, null, 1));
const CH = 300;
let chunks = 0;
for (let i = 0; i < members.length; i += CH) {
  const add = members.slice(i, i + CH).map((m) => (m.k === "call" ? { id: m.id, k: "call", class: m.class, function: m.function } : { id: m.id, k: "get", class: m.class, name: m.name }));
  const spec = [{
    asset: "/goodsoupWagdD/_abfcSpike/BP_ReflectPins",
    create: { class: "Blueprint", parent: "/Script/Engine.Actor", if_missing: true },
    graphs: [{ graph: "EventGraph", add }],
  }];
  writeFileSync(join(outDir, `r2.chunk${chunks}.spec.json`), JSON.stringify(spec));
  chunks++;
}
console.log(JSON.stringify({ members: members.length, chunks, skipped: skipped.length, props: Object.fromEntries(Object.entries(props).map(([k, v]) => [k.split("/").pop(), v.length])) }));
