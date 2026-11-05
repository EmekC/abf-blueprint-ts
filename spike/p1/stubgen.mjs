// Spike stub generator (P1 + P2). Usage:
//   node stubgen.mjs --tmpl <t3d>[,<t3d>...] --map <r2.map.json> --out <dir>
//                    [--filter <BlueprintFilter.txt>] [--overrides <filterOverrides.json>]
// Reads pin templates (R2 export) and writes <out>/<Module or GamePath>.d.ts + <out>/_index.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseNodes, memberOf } from "./t3dparse.mjs";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i < 0 ? d : process.argv[i + 1]; };
const tmplFiles = arg("tmpl").split(",");
const outDir = arg("out");
const map = JSON.parse(readFileSync(arg("map"), "utf8")).map;
const filterFile = arg("filter");
const overridesFile = arg("overrides");

// ---- filter (port of bpscan.load_filter / resolve) ----
function loadRules(file) {
  const rules = new Map();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 2 && (p[0] === "Allow" || p[0] === "Block")) rules.set(p[1] + (p.length > 2 ? " " + p[2] : ""), p[0]);
  }
  return rules;
}
export function resolve(rules, parent, member) {
  if (member && rules.has(`${parent} ${member}`)) return [rules.get(`${parent} ${member}`), `${parent} ${member}`];
  if (rules.has(parent)) return [rules.get(parent), parent];
  const mod = parent.split(".")[0];
  if (rules.has(mod)) return [rules.get(mod), mod];
  if (parent.startsWith("/Game/") || parent.startsWith("/Engine/")) return ["Allow", null];
  return ["Unlisted", null];
}
const rules = filterFile ? loadRules(filterFile) : null;
const overrides = overridesFile ? JSON.parse(readFileSync(overridesFile, "utf8")).filterOverrides ?? [] : [];
const overrideFor = (parent, member) => overrides.find((o) => o.parent === parent && o.member === member);

// ---- templates by identity ----
const byKey = new Map();
for (const f of tmplFiles) for (const n of parseNodes(readFileSync(f, "utf8")).values()) {
  const m = memberOf(n);
  if (m && (m.kind === "call" || m.kind === "var") && m.parent) byKey.set(`${m.kind}|${m.parent}|${m.member}`, { node: n, m });
}

// ---- type mapping ----
const shortName = (p) => (p ? p.slice(p.lastIndexOf(".") + 1) : "unknown");
function tsType(p) {
  let t;
  switch (p.PinCategory) {
    case "bool": t = "boolean"; break;
    case "int": t = "int"; break;
    case "int64": t = "int64"; break;
    case "byte": t = p.PinSubCategoryObject ? shortName(p.PinSubCategoryObject) : "byte"; break;
    case "real": t = p.PinSubCategory === "float" ? "float" : "double"; break;
    case "double": t = "double"; break;
    case "float": t = "float"; break;
    case "name": t = "name"; break;
    case "string": t = "string"; break;
    case "text": t = "text"; break;
    case "object": case "interface": t = shortName(p.PinSubCategoryObject) + " | null"; break;
    case "class": t = `Class<${shortName(p.PinSubCategoryObject)}> | null`; break;
    case "softobject": case "softclass": t = `Soft<${shortName(p.PinSubCategoryObject)}> | null`; break;
    case "struct": t = shortName(p.PinSubCategoryObject); break;
    case "wildcard": t = "unknown"; break;
    default: t = "unknown /* " + p.PinCategory + " */";
  }
  if (p.ContainerType === "Array") t = t.includes(" | ") ? `(${t})[]` : t + "[]";
  else if (p.ContainerType !== "None") t = `unknown /* ${p.ContainerType} */`;
  return t;
}
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED = new Set(["default", "function", "class", "new", "var", "let", "const", "delete", "in", "of", "enum", "export", "import", "return", "switch", "case", "this", "super", "type", "void", "with", "yield", "null", "true", "false"]);
const ident = (s) => { let r = s.replace(/[^A-Za-z0-9_$]/g, "_"); if (/^[0-9]/.test(r)) r = "_" + r; return RESERVED.has(r) ? r + "_" : r; };

function fileFor(parent) {
  if (parent.startsWith("/Game/")) return "Game" + parent.slice(5, parent.lastIndexOf(".")) + ".d.ts";
  const mod = parent.split(".")[0].split("/").pop();
  return mod + ".d.ts";
}

// ---- build members ----
const classes = new Map(); // parent -> {instance:[], statics:[], fields:[]}
const report = { members: 0, withPins: 0, deprecated: 0, overridden: 0, missing: [], deprecatedList: [], overriddenList: [] };
for (const d of Object.values(map)) {
  const parent = d.class, member = d.member;
  const t = byKey.get(`${d.kind === "call" ? "call" : "var"}|${parent}|${member}`);
  report.members++;
  if (!t) { report.missing.push(`${parent}:${member}`); continue; }
  report.withPins++;
  const { node, m } = t;
  const c = classes.get(parent) ?? { instance: [], statics: [], fields: [] };
  classes.set(parent, c);
  const tags = [`@bpPath ${parent}:${member}`];
  if (m.guid) tags.push(`@bpGuid ${m.guid}`);
  if (!node.cls.endsWith("K2Node_CallFunction") && !node.cls.endsWith("K2Node_VariableGet")) tags.push(`@bpNode ${node.cls.split(".").pop()}`);
  let deprecated = null, ovr = null;
  if (rules) {
    const [verdict, rule] = resolve(rules, parent, member);
    if (verdict === "Block") {
      const o = overrideFor(parent, member);
      if (o) { ovr = `${verdict} ${rule}: ${o.reason}`; report.overridden++; report.overriddenList.push(`${parent}:${member}`); }
      else { deprecated = `Blocked by Blueprint filter: ${verdict} ${rule}`; report.deprecated++; report.deprecatedList.push(`${parent}:${member}`); }
    }
  }
  if (deprecated) tags.push(`@deprecated ${deprecated}`);
  if (ovr) tags.push(`@bpFilterOverride ${ovr}`);
  if (d.kind === "get") {
    const out = node.pins.find((p) => p.Direction === "out" && p.PinName === member) ?? node.pins.find((p) => p.Direction === "out");
    const key = IDENT.test(member) ? member : JSON.stringify(member);
    c.fields.push({ tags, line: `${key}: ${out ? tsType(out) : "unknown"};` });
    continue;
  }
  const pins = node.pins;
  const execIn = pins.filter((p) => p.PinCategory === "exec" && p.Direction === "in");
  const execOut = pins.filter((p) => p.PinCategory === "exec" && p.Direction === "out");
  const extraExec = execOut.filter((p) => p.PinName !== "then").map((p) => p.PinName);
  if (execIn.length === 0 && execOut.length === 0) tags.push("@bpPure");
  if (parent === "/Script/Engine.KismetArrayLibrary" && pins.some((p) => p.PinCategory === "wildcard" && p.ContainerType === "Array")) tags.push("@bpNode K2Node_CallArrayFunction");
  if (extraExec.length) tags.push(`@bpExecOutputs ${extraExec.join(",")}`);
  const self = pins.find((p) => p.PinName === "self" && p.Direction === "in");
  const instance = !!self && !self.bHidden;
  const params = [], outs = [];
  for (const p of pins) {
    if (p.PinCategory === "exec" || p.PinName === "self") continue;
    if (p.PinName === "LatentInfo") { tags.push("@bpLatent"); continue; }
    if (p.bHidden) { if (/WorldContext/.test(p.PinName)) tags.push("@bpWorldContext"); continue; }
    const id2 = ident(p.PinName);
    if (id2 !== p.PinName) tags.push(`@bpPin ${id2} ${JSON.stringify(p.PinName)}`);
    (p.Direction === "in" ? params : outs).push({ name: id2, type: tsType(p) });
  }
  let ret;
  if (extraExec.length) ret = `{ exec: ${extraExec.map((x) => JSON.stringify(x)).join(" | ")};${outs.map((o) => ` ${o.name}: ${o.type};`).join("")} }`;
  else if (outs.length === 0) ret = "void";
  else if (outs.length === 1 && outs[0].name === "ReturnValue") ret = outs[0].type;
  else ret = `{ ${outs.map((o) => `${o.name}: ${o.type}`).join("; ")} }`;
  const sig = `${member}(${params.map((p) => `${p.name}: ${p.type}`).join(", ")}): ${ret};`;
  (instance ? c.instance : c.statics).push({ tags, line: instance ? sig : "function " + sig });
}

// casts: a class that resolves to Block gets @bpCastFilter; a cast listed in filterOverrides is tagged as override.
const castOverrides = overrides.filter((o) => o.cast);
for (const o of castOverrides) if (!classes.has(o.cast)) classes.set(o.cast, { instance: [], statics: [], fields: [] });
const castTag = (parent) => {
  if (!rules) return null;
  const [verdict, rule] = resolve(rules, parent, null);
  if (verdict !== "Block") return null;
  const o = castOverrides.find((x) => x.cast === parent);
  return o ? `@bpCastFilter override ${verdict} ${rule}: ${o.reason}` : `@bpCastFilter Blocked by Blueprint filter: ${verdict} ${rule}`;
};
const jsdoc = (tags, ind) => `${ind}/**\n${tags.map((t) => `${ind} * ${t}`).join("\n")}\n${ind} */\n`;
const byFile = new Map();
for (const [parent, c] of classes) {
  const name = shortName(parent);
  let s = "";
  if (c.instance.length || c.fields.length || !c.statics.length) {
    s += `declare class ${name} {\n`;
    for (const x of c.fields) s += jsdoc(x.tags, "  ") + `  ${x.line}\n`;
    for (const x of c.instance) s += jsdoc(x.tags, "  ") + `  ${x.line}\n`;
    s += "}\n";
  }
  if (c.statics.length) {
    s += `declare namespace ${name} {\n`;
    for (const x of c.statics) s += jsdoc(x.tags, "  ") + `  ${x.line}\n`;
    s += "}\n";
  }
  const f = fileFor(parent);
  const ct = castTag(parent);
  if (ct) report.castTags = [...(report.castTags ?? []), `${parent}: ${ct}`];
  byFile.set(f, (byFile.get(f) ?? `// generated by spike/p1/stubgen.mjs - throwaway\n`) + `\n/**\n * @bpPath ${parent}${ct ? "\n * " + ct : ""}\n */\n` + s);
}
for (const [f, text] of byFile) {
  mkdirSync(dirname(join(outDir, f)), { recursive: true });
  writeFileSync(join(outDir, f), text);
}
writeFileSync(join(outDir, "_index.json"), JSON.stringify({ files: [...byFile.keys()], report }, null, 1));
console.log(JSON.stringify({ files: byFile.size, members: report.members, withPins: report.withPins, deprecated: report.deprecated, overridden: report.overridden, missing: report.missing.length }));
