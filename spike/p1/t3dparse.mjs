// Minimal T3D reader shared by the P1/P2 spike scripts. parseNodes(text) -> Map<name, {name, cls, head:[], pins:[]}>.
// Only body blocks (those carrying ExportPath) are read; the bare class-header stubs are ignored.
export function parseAttrs(s) {
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
export const unq = (v) => (v === undefined ? undefined : v.replace(/^"|"$/g, ""));

// "/Script/CoreUObject.Class'/Script/Engine.Controller'" -> "/Script/Engine.Controller"
export function innerPath(v) {
  if (v === undefined || v === null) return null;
  const s = unq(v);
  const m = s.match(/'([^']*)'/);
  return m ? m[1] : s || null;
}

export function parsePin(line) {
  const m = line.match(/CustomProperties Pin \((.*)\)\s*$/);
  if (!m) return null;
  const a = parseAttrs(m[1]);
  return {
    PinName: unq(a.PinName),
    Direction: unq(a.Direction) === "EGPD_Output" ? "out" : "in",
    PinCategory: unq(a["PinType.PinCategory"]),
    PinSubCategory: unq(a["PinType.PinSubCategory"]) ?? "",
    PinSubCategoryObject: innerPath(a["PinType.PinSubCategoryObject"]),
    ContainerType: a["PinType.ContainerType"] ?? "None",
    bHidden: a.bHidden === "True",
    DefaultValue: unq(a.DefaultValue),
  };
}

export function parseNodes(text) {
  const lines = text.split(/\r?\n/);
  const nodes = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*Begin Object Name="([^"]+)" ExportPath="[^']*'([^']*)'"/);
    if (!m) continue;
    const cls = m[2].replace(/'.*$/, "");
    const node = { name: m[1], cls: lines[i].match(/ExportPath="([^']*)'/)[1], head: [], pins: [] };
    for (i++; i < lines.length && !/^\s*End Object/.test(lines[i]); i++) {
      const l = lines[i].trim();
      if (/^Begin Object /.test(l)) { i--; break; } // nested object: let the outer loop read it as its own node
      if (l.startsWith("CustomProperties Pin (")) { const p = parsePin(l); if (p) node.pins.push(p); }
      else node.head.push(l);
    }
    nodes.set(node.name, node);
  }
  return nodes;
}

// Member identity of a call/variable node: {kind, parent, member, guid, selfContext} or null.
export function memberOf(node) {
  for (const l of node.head) {
    const m = l.match(/^(FunctionReference|VariableReference|EventReference)=\((.*)\)$/);
    if (!m) continue;
    const a = parseAttrs(m[2]);
    return {
      kind: m[1] === "FunctionReference" ? "call" : m[1] === "VariableReference" ? "var" : "event",
      parent: innerPath(a.MemberParent),
      member: unq(a.MemberName),
      guid: a.MemberGuid ?? null,
      selfContext: a.bSelfContext === "True",
    };
  }
  return null;
}
