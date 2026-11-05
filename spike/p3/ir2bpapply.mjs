// D4: IR -> bp_apply spec adapter (design 7.3), spike version.
// node spike/p3/ir2bpapply.mjs <ir.json> [out.spec.json] [idmap.json]
// node with `sem` -> native kind; without `sem` -> {k:"node", class, props}. ShowPinForProperties lines are dropped from k:"node" props
// (P5 proved the minimal BreakStruct head lines are enough). Variable flags: transient -> 8192, plus BlueprintVisible 4 = 8196.
import fs from "node:fs";
const [irFile, outFile = "spike/out/p3/apply.spec.json", mapFile = "spike/out/p3/idmap.json"] = process.argv.slice(2);
if (!irFile) { console.error("usage: ir2bpapply.mjs <ir.json> [out] [idmap]"); process.exit(2); }
const ir = JSON.parse(fs.readFileSync(irFile, "utf8"));
const refText = fs.readFileSync("spike/out/ref/BP_SoupInfoRelay.export.t3d", "utf8");
const refEventGraphNodes = new Set([...refText.matchAll(/Begin Object Name="([^"]+)" ExportPath="[^"]*:EventGraph\.[^."']+'"/g)].map((m) => m[1]));

const FLAGS = { transient: 8192 };
const idmap = {};
const specs = [];
const problems = [];
for (const asset of ir.assets) {
  const spec = { asset: asset.path };
  if (asset.variables.length) {
    spec.variables = asset.variables.map((v) => ({
      name: v.name, type: v.type,
      flags: 4 + v.flags.reduce((s, f) => s | (FLAGS[f] ?? 0), 0),
    }));
  }
  const graphs = new Map();
  for (const u of asset.units) {
    const g = graphs.get(u.graph) ?? { graph: u.graph, remove: [], add: [], wires: [] };
    graphs.set(u.graph, g);
    const ids = new Set();
    const mapId = (id) => "u_" + id.replace(/[^A-Za-z0-9_]/g, "_");
    for (const n of u.nodes) {
      const id = mapId(n.id);
      if (ids.has(id)) problems.push(`duplicate id ${id}`);
      ids.add(id);
      idmap[`${u.id}/${n.id}`] = id;
      const out = { id };
      const s = n.sem;
      if (s) {
        out.k = s.k;
        if (s.k === "event" || s.k === "get" || s.k === "set") out.name = s.name;
        if ((s.k === "get" || s.k === "set") && s.class) out.class = s.class;
        if (s.k === "call") { if (s.class) out.class = s.class; out.function = s.function; }
        if (s.k === "cast") out.target = s.target;
        if (s.k === "override") { out.class = s.class; out.function = s.function; }
      } else {
        out.k = "node";
        out.class = n.t3d.class;
        out.props = n.t3d.props.filter((l) => !/^ShowPinForProperties\(/.test(l) && !/^AdvancedPinDisplay=/.test(l));
      }
      if (n.pinDefaults && Object.keys(n.pinDefaults).length) out.set = { ...n.pinDefaults };
      if (n.pinObjects && Object.keys(n.pinObjects).length) out.objects = { ...n.pinObjects };
      g.add.push(out);
    }
    for (const [a, b] of u.wires) {
      const conv = (e) => { const d = e.indexOf("."); const id = e.slice(0, d); if (!ids.has(mapId(id))) problems.push(`undeclared node in wire ${a} -> ${b}: ${id}`); return mapId(id) + e.slice(d); };
      g.wires.push([conv(a), conv(b)]);
    }
    for (const r of u.adopt?.remove ?? []) {
      if (!refEventGraphNodes.has(r)) problems.push(`remove name not in reference EventGraph: ${r}`);
      g.remove.push(r);
    }
    // dry check: wire end ids may only be declared ids (existing-node wiring is not used in this slice)
    if (new Set(g.add.map((x) => x.id)).size !== g.add.length) problems.push("duplicate ids in add");
    if (g.add.some((x) => x.id.includes("."))) problems.push("id with dot");
  }
  spec.graphs = [...graphs.values()];
  specs.push(spec);
}
fs.mkdirSync(outFile.replace(/[\\/][^\\/]*$/, ""), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(specs, null, 1));
fs.writeFileSync(mapFile, JSON.stringify(idmap, null, 1));
const g = specs[0].graphs[0];
console.log(JSON.stringify({ assets: specs.length, add: g.add.length, wires: g.wires.length, remove: g.remove.length, rawNodes: g.add.filter((x) => x.k === "node").map((x) => x.id), problems }));
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
