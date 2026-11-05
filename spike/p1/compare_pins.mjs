// Spike P1: compares the ordered PinName list of every member node in the reference export (BP_SoupInfoRelay, 2026-11-05)
// with the pins materialized by R2, and checks the roadmap criteria on the generated stubs.
// Usage: node compare_pins.mjs [--ref <t3d>] [--tmpl <t3d>] [--stubs <dir>] [--out <dir>]   (exit 1 when a check fails)
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNodes, memberOf } from "./t3dparse.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const out = arg("out", join(here, "..", "out", "p1"));
const refFile = arg("ref", join(here, "..", "out", "ref", "BP_SoupInfoRelay.export.t3d"));
const tmplFile = arg("tmpl", join(out, "r2-3.t3d"));
const stubs = arg("stubs", join(out, "stubs"));
const ref = parseNodes(readFileSync(refFile, "utf8"));
const tmpl = parseNodes(readFileSync(tmplFile, "utf8"));
const tmplBy = new Map();
for (const n of tmpl.values()) { const m = memberOf(n); if (m && m.parent) tmplBy.set(`${m.kind}|${m.parent}|${m.member}`, n); }
const rows = [], seen = new Set();
for (const n of ref.values()) {
  const m = memberOf(n);
  if (!m || !m.parent || m.kind === "event") continue;
  const key = `${m.kind}|${m.parent}|${m.member}`;
  const t = tmplBy.get(key);
  if (!t) continue;
  const refPins = n.pins.map((p) => p.PinName);
  const stubPins = t.pins.map((p) => p.PinName);
  const sig = key + "|" + refPins.join("\u0001");
  if (seen.has(sig)) continue;
  seen.add(sig);
  const equalSet = [...refPins].sort().join("\u0001") === [...stubPins].sort().join("\u0001");
  rows.push({ member: `${m.parent}:${m.member}`, kind: m.kind, refNode: n.name, refClass: n.cls.split(".").pop(), stubClass: t.cls.split(".").pop(), ref: refPins, stub: stubPins, equal: refPins.join("\u0001") === stubPins.join("\u0001"), equalAsSet: equalSet });
}
writeFileSync(join(out, "compare.json"), JSON.stringify(rows, null, 1));
const read = (f) => readFileSync(join(stubs, f), "utf8");
const player = read("Game/Blueprints/Characters/Abiotic_PlayerCharacter.d.ts");
const pot = read("Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup.d.ts");
const eng = read("Engine.d.ts");
const abf = read("AbioticFactor.d.ts");
const block = (txt, name) => { const i = txt.indexOf(name); return i < 0 ? "" : txt.slice(Math.max(0, txt.lastIndexOf("/**", i)), txt.indexOf("\n", i)); };
const gg = block(abf, "function GetGlobalItemRow(");
const conv = block(abf, "function Conv_GlobalItemToName(");
const check = {
  BestInteractable_InteractA_Actor_null: /BestInteractable_InteractA: Actor \| null;/.test(player),
  CanFillSoupBowl_boolean: /CanFillSoupBowl: boolean;/.test(pot),
  ItemRow: /\bItemRow: /.test(pot),
  Controller_K2_GetPawn: /declare class Controller \{[\s\S]*?K2_GetPawn\(/.test(eng),
  GetGlobalItemRow_exec_Valid_NotValid: /@bpExecOutputs Valid,NotValid/.test(gg),
  GetGlobalItemRow_pins_RowHandle_Data: /RowHandle: /.test(gg) && /Data: /.test(gg),
  Conv_GlobalItemToName_pure: /@bpPure/.test(conv),
  pin_names_byte_identical: rows.length > 0 && rows.every((r) => r.equal),
};
const mismatches = rows.filter((r) => !r.equal);
writeFileSync(join(out, "check.json"), JSON.stringify({ check, compared: rows.length, mismatches: mismatches.length, mismatchMembers: mismatches.map((r) => r.member) }, null, 1));
console.log(JSON.stringify({ check, compared: rows.length, mismatches: mismatches.map((r) => ({ member: r.member, equalAsSet: r.equalAsSet })) }, null, 1));
process.exit(Object.values(check).every(Boolean) ? 0 : 1);
