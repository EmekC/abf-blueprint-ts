// Usage: node pins.mjs <file.t3d> <NodeName> [NodeName...]  -> JSON {node: [pins]} on stdout
// Parses CustomProperties Pin lines inside "Begin Object Name=<node>" blocks (the body blocks, not the class-header stubs).
import { readFileSync } from "node:fs";
const [file, ...names] = process.argv.slice(2);
if (!file || names.length === 0) { console.error("usage: pins.mjs <t3d> <node>..."); process.exit(2); }
const lines = readFileSync(file, "utf8").split(/\r?\n/);
// Split "k=v,k=v,..." at top level (respecting quotes and parentheses) into a map.
function parseAttrs(s) {
  const map = {};
  let i = 0;
  while (i < s.length) {
    const eq = s.indexOf("=", i);
    if (eq < 0) break;
    const key = s.slice(i, eq);
    let j = eq + 1, depth = 0, inq = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inq) { if (c === "\\") j++; else if (c === '"') inq = false; continue; }
      if (c === '"') inq = true;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) break;
    }
    map[key] = s.slice(eq + 1, j);
    i = j + 1;
  }
  return map;
}
const unq = (v) => (v === undefined ? undefined : v.replace(/^"|"$/g, ""));
const out = {};
for (const name of names) {
  const start = lines.findIndex((l) => l.includes(`Begin Object Name="${name}"`));
  if (start < 0) { out[name] = null; continue; }
  const pins = [];
  for (let i = start + 1; i < lines.length && !/^\s*End Object/.test(lines[i]); i++) {
    const m = lines[i].match(/CustomProperties Pin \((.*)\)\s*$/);
    if (!m) continue;
    const a = parseAttrs(m[1]);
    const attr = (_, k) => unq(a[k]);
    const s = null;
    pins.push({
      PinName: attr(s, "PinName"),
      Direction: attr(s, "Direction") === "EGPD_Output" ? "out" : "in",
      PinCategory: attr(s, "PinType.PinCategory"),
      PinSubCategory: attr(s, "PinType.PinSubCategory"),
      PinSubCategoryObject: attr(s, "PinType.PinSubCategoryObject"),
      ContainerType: attr(s, "PinType.ContainerType"),
      bHidden: attr(s, "bHidden") === "True",
      DefaultValue: attr(s, "DefaultValue"),
      LinkedTo: attr(s, "LinkedTo"),
    });
  }
  out[name] = pins;
}
console.log(JSON.stringify(out, null, 2));
