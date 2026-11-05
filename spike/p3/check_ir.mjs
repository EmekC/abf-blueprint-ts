// D3 check: every wire endpoint of spike/out/p3/UpdateTarget.ir.json exists (right direction) in pin data taken from the
// reference export (refNode, EventGraph) or the P1 materialized templates (member lookup) or, for variable get/set
// without a reference node, the variable-name rule from the handoff. Exit 1 on any failure.
// node spike/p3/check_ir.mjs [ir.json]
import fs from "node:fs";
import { parseNodes, memberOf } from "../p1/t3dparse.mjs";

const irFile = process.argv[2] ?? "spike/out/p3/UpdateTarget.ir.json";
const ir = JSON.parse(fs.readFileSync(irFile, "utf8"));
const refText = fs.readFileSync("spike/out/ref/BP_SoupInfoRelay.export.t3d", "utf8");

// reference pins per EventGraph node (name -> pins [{PinName, Direction, PinCategory}]), all graphs for class lookups
const egPins = new Map();
const arrayItemPins = [];
{
  const ls = refText.split(/\r?\n/);
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(/^\s*Begin Object Name="([^"]+)" ExportPath="([^']*)'([^']*)'/);
    if (!m) continue;
    const pins = [];
    for (i++; i < ls.length && !/^\s*End Object/.test(ls[i]); i++) {
      const l = ls[i].trim();
      if (!l.startsWith("CustomProperties Pin (")) continue;
      pins.push({ name: l.match(/PinName="([^"]*)"/)[1], dir: /Direction="EGPD_Output"/.test(l) ? "out" : "in", cat: l.match(/PinType\.PinCategory="([^"]*)"/)[1] });
    }
    if (/:EventGraph\.[^.]+$/.test(m[3])) egPins.set(m[1], pins);
    if (m[2].endsWith("K2Node_GetArrayItem") && arrayItemPins.length === 0) arrayItemPins.push(...pins);
  }
}
// P1 templates by member
const tmplBy = new Map();
for (const f of ["r2-0", "r2-1", "r2-2", "r2-3"]) {
  const p = `spike/out/p1/${f}.t3d`;
  if (!fs.existsSync(p)) continue;
  for (const n of parseNodes(fs.readFileSync(p, "utf8")).values()) {
    const m = memberOf(n);
    if (m && m.parent) tmplBy.set(`${m.parent}|${m.member}`, n.pins.map((q) => ({ name: q.PinName, dir: q.Direction, cat: q.PinCategory })));
  }
}

const fails = [];
const report = [];
for (const asset of ir.assets) {
  const varNames = new Set(asset.variables.map((v) => v.name));
  for (const unit of asset.units) {
    const byId = new Map();
    const pinsOf = new Map();
    for (const n of unit.nodes) {
      if (byId.has(n.id)) fails.push(`duplicate node id ${n.id}`);
      byId.set(n.id, n);
      let pins = null, src = "";
      if (n.refNode) { pins = egPins.get(n.refNode); src = "ref:" + n.refNode; }
      else if (n.member?.arrayItem) { pins = arrayItemPins; src = "ref:K2Node_GetArrayItem"; }
      else if (n.member?.class) { pins = tmplBy.get(`${n.member.class}|${n.member.function}`); src = "p1:" + n.member.function; }
      else if (n.sem && (n.sem.k === "get" || n.sem.k === "set") && varNames.has(n.sem.name)) {
        pins = n.sem.k === "get"
          ? [{ name: n.sem.name, dir: "out", cat: "?" }, { name: "self", dir: "in", cat: "object" }]
          : [{ name: "execute", dir: "in", cat: "exec" }, { name: "then", dir: "out", cat: "exec" }, { name: n.sem.name, dir: "in", cat: "?" }, { name: "Output_Get", dir: "out", cat: "?" }, { name: "self", dir: "in", cat: "object" }];
        src = "rule:var";
      }
      if (!pins) { fails.push(`node ${n.id}: no pin source`); continue; }
      pinsOf.set(n.id, pins);
      report.push(`${n.id}\t${src}\t${pins.length} pins`);
    }
    for (const [a, b] of unit.wires) {
      for (const [end, want] of [[a, "out"], [b, "in"]]) {
        const dot = end.indexOf(".");
        const id = end.slice(0, dot), pin = end.slice(dot + 1);
        const pins = pinsOf.get(id);
        if (!byId.has(id)) { fails.push(`wire ${a} -> ${b}: undeclared node ${id}`); continue; }
        if (!pins) continue;
        const p = pins.find((q) => q.name === pin && q.dir === want);
        if (!p) fails.push(`wire ${a} -> ${b}: no ${want} pin "${pin}" on ${id} (${[...new Set(pins.map((q) => q.name + "/" + q.dir))].join(", ")})`);
      }
      // exec only with exec
      const pa = pinsOf.get(a.slice(0, a.indexOf(".")))?.find((q) => q.name === a.slice(a.indexOf(".") + 1) && q.dir === "out");
      const pb = pinsOf.get(b.slice(0, b.indexOf(".")))?.find((q) => q.name === b.slice(b.indexOf(".") + 1) && q.dir === "in");
      if (pa && pb && (pa.cat === "exec") !== (pb.cat === "exec")) fails.push(`wire ${a} -> ${b}: exec/data mix`);
    }
    // adopt.remove names exist in the reference EventGraph
    for (const r of unit.adopt?.remove ?? []) if (!egPins.has(r)) fails.push(`adopt.remove: ${r} not in reference EventGraph`);
    for (const [k, v] of Object.entries(unit.nodes.reduce((m, n) => (n.pinDefaults ? { ...m, [n.id]: n.pinDefaults } : m), {}))) {
      for (const pin of Object.keys(v)) {
        const pins = pinsOf.get(k);
        if (pins && !pins.some((q) => q.name === pin && q.dir === "in")) fails.push(`pinDefault ${k}.${pin}: no input pin`);
      }
    }
    console.log(`unit ${unit.id}: ${unit.nodes.length} nodes, ${unit.wires.length} wires, remove ${unit.adopt?.remove?.length ?? 0}`);
  }
}
fs.mkdirSync("spike/out/p3", { recursive: true });
fs.writeFileSync("spike/out/p3/check_ir.json", JSON.stringify({ ok: fails.length === 0, fails, report }, null, 1));
if (fails.length) { console.error(fails.join("\n")); process.exit(1); }
console.log("check_ir: OK");
