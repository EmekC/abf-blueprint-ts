// D2: owned/shared/incoming node sets of the UpdateTarget unit in the reference export (EventGraph only).
// node spike/p3/unit_nodes.mjs [export.t3d] [out.json]
import fs from "node:fs";
const ref = process.argv[2] ?? "spike/out/ref/BP_SoupInfoRelay.export.t3d";
const out = process.argv[3] ?? "spike/out/p3/unit.json";
const lines = fs.readFileSync(ref, "utf8").split(/\r?\n/);
const nodes = new Map(); // name -> {cls, pins:[{name,dir,cat,links:[nodeName]}]}
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*Begin Object Name="([^"]+)" ExportPath="([^']*)'([^']*)'/);
  if (!m || !/:EventGraph\.[^.]+$/.test(m[3])) continue;
  const n = { name: m[1], cls: m[2].split(".").pop(), pins: [] };
  for (i++; i < lines.length && !/^\s*End Object/.test(lines[i]); i++) {
    const l = lines[i].trim();
    if (!l.startsWith("CustomProperties Pin (")) continue;
    const name = l.match(/PinName="([^"]*)"/)[1];
    const dir = /Direction="EGPD_Output"/.test(l) ? "out" : "in";
    const cat = l.match(/PinType\.PinCategory="([^"]*)"/)[1];
    const lt = l.match(/LinkedTo=\(([^)]*)\)/);
    const links = lt ? lt[1].split(",").map((s) => s.trim().split(" ")[0]).filter(Boolean) : [];
    const hidden = /bHidden=True/.test(l);
    n.pins.push({ name, dir, cat, links, hidden });
  }
  nodes.set(n.name, n);
}
const isComment = (n) => n.cls === "EdGraphNode_Comment";
const isEntry = (n) => (n.cls === "K2Node_CustomEvent" || n.cls === "K2Node_Event") ;
const execOut = (n) => n.pins.filter((p) => p.dir === "out" && p.cat === "exec");
const hasExec = (n) => n.pins.some((p) => p.cat === "exec");
// exec reachability from an entry (exec out links)
function reach(start) {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const n = nodes.get(q.pop());
    for (const p of execOut(n)) for (const t of p.links) if (nodes.has(t) && !seen.has(t)) { seen.add(t); q.push(t); }
  }
  return seen;
}
// add pure feeders (no exec pins) transitively through input pins
function withFeeders(set) {
  const res = new Set(set);
  const q = [...set];
  while (q.length) {
    const n = nodes.get(q.pop());
    for (const p of n.pins) {
      if (p.dir !== "in" || p.cat === "exec") continue;
      for (const t of p.links) {
        const tn = nodes.get(t);
        if (tn && !hasExec(tn) && !isComment(tn) && !res.has(t)) { res.add(t); q.push(t); }
      }
    }
  }
  return res;
}
const START = "K2Node_CustomEvent_3";
const mine = withFeeders(reach(START));
const others = new Set();
for (const n of nodes.values()) if (isEntry(n) && n.name !== START) for (const t of withFeeders(reach(n.name))) others.add(t);
const owned = [], shared = [];
for (const t of mine) { if (isComment(nodes.get(t))) continue; (others.has(t) ? shared : owned).push(t); }
const ownedSet = new Set(owned);
const incoming = [];
for (const n of nodes.values()) {
  if (mine.has(n.name) || isComment(n)) continue;
  for (const p of n.pins) for (const t of p.links) if (ownedSet.has(t) || t === START) incoming.push({ node: n.name, cls: n.cls, pin: p.name, to: t });
}
// also report pure feeders owned only through shared exec chains: none expected
const classes = {};
for (const t of owned) classes[nodes.get(t).cls] = (classes[nodes.get(t).cls] ?? 0) + 1;
const res = { owned: owned.sort(), shared, incoming, count: owned.length, classes, totalEventGraphNodes: nodes.size, entries: [...nodes.values()].filter(isEntry).map((n) => n.name) };
fs.mkdirSync(out.replace(/[\/][^\/]*$/, ""), { recursive: true });
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ count: res.count, shared: shared.length, incoming, classes, entries: res.entries, total: nodes.size }));
