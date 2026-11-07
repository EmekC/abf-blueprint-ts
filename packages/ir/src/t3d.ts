// Pure text tools for Unreal T3D exports (Blueprint copy format). No file or network access.
import { bpTypeFromPin, parseBpType, pinObjectText } from "./bptype.js";
import { canonicalJson, sha256 } from "./hash.js";

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

/** `PinValueType` of a map pin or variable: the value type (the pin's own category is the key). */
export interface T3dValueType { category: string; subCategory: string; subCategoryObject: string | null }
export interface T3dPin {
  id: string;
  name: string;
  dir: "in" | "out";
  category: string;
  subCategory: string;
  subCategoryObject: string | null; // inner path
  container: string;
  /** Value type of a map pin; null for everything else. */
  valueType: T3dValueType | null;
  hidden: boolean;
  defaultValue: string | null;
  defaultObject: string | null;
  links: Array<{ node: string; pinId: string }>;
  raw: string;
}
export interface T3dNode {
  name: string;
  /** Full class path, e.g. `/Script/BlueprintGraph.K2Node_CallFunction`. */
  cls: string;
  graph: string | null;
  /** Non-pin property lines of the node body, trimmed. */
  head: string[];
  pins: T3dPin[];
}
export interface T3dExport {
  /**
   * Keyed by node name. When two graphs hold a node of the same name (e.g. `K2Node_FunctionEntry_0`), the first graph
   * keeps the plain name and later ones are keyed `<graph>/<name>` (`T3dNode.name` is always the real name).
   */
  nodes: Map<string, T3dNode>;
  variables: Array<{ name: string; type: string; default: string | null; propertyFlags: string | null }>;
  parentClass: string | null;
  /**
   * Designer widgets of a Widget Blueprint (children of its `WidgetTree`, slots excluded) in declaration order; empty for other
   * assets. `isVariable` is true when the definition block carries `bIsVariable=True` (the designer's "Is Variable" checkbox).
   */
  widgets: Array<{ name: string; cls: string; isVariable: boolean }>;
}

/** Split `k=v,k=v,...` at top level (respecting quotes and parentheses) into a map. Values keep their quotes/parentheses. */
export function parseAttrs(s: string): Record<string, string> {
  const map: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    const eq = s.indexOf("=", i);
    if (eq < 0) break;
    const key = s.slice(i, eq);
    let j = eq + 1;
    let depth = 0;
    let inq = false;
    for (; j < s.length; j++) {
      const c = s[j];
      if (inq) {
        if (c === "\\") j++;
        else if (c === '"') inq = false;
        continue;
      }
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

const unq = (v: string | undefined): string | undefined => (v === undefined ? undefined : v.replace(/^"|"$/g, ""));
const unparen = (v: string | undefined): string => (v === undefined ? "" : v.replace(/^\(/, "").replace(/\)$/, ""));

/** `Class'/Path.Name'` -> `/Path.Name`; `None`, empty or absent -> null; a bare path is returned as is. */
function innerPath(v: string | undefined): string | null {
  if (v === undefined || v === "" || v === "None") return null;
  const a = v.indexOf("'");
  const b = v.lastIndexOf("'");
  return a >= 0 && b > a ? v.slice(a + 1, b) : v;
}

function parseLinks(v: string | undefined): Array<{ node: string; pinId: string }> {
  if (v === undefined) return [];
  const out: Array<{ node: string; pinId: string }> = [];
  for (const part of unparen(v).split(",")) {
    const bits = part.trim().split(/\s+/);
    if (bits[0]) out.push({ node: bits[0], pinId: bits[1] ?? "" });
  }
  return out;
}

/** `(TerminalCategory="int",TerminalSubCategory="",TerminalSubCategoryObject=...)` -> value type; `()`, empty or absent -> null. */
function valueTypeOf(v: string | undefined): T3dValueType | null {
  if (v === undefined) return null;
  const a = parseAttrs(unparen(v));
  const category = unq(a["TerminalCategory"]) ?? "";
  if (category === "") return null;
  return {
    category,
    subCategory: unq(a["TerminalSubCategory"]) ?? "",
    subCategoryObject: innerPath(unq(a["TerminalSubCategoryObject"])),
  };
}

function parsePinLine(raw: string): T3dPin | null {
  const m = /^\s*CustomProperties Pin \((.*)\)\s*$/.exec(raw);
  if (!m || m[1] === undefined) return null;
  const a = parseAttrs(m[1]);
  const defaultObject = a["DefaultObject"] === undefined ? null : innerPath(unq(a["DefaultObject"]));
  return {
    id: a["PinId"] ?? "",
    name: unq(a["PinName"]) ?? "",
    dir: unq(a["Direction"]) === "EGPD_Output" ? "out" : "in",
    category: unq(a["PinType.PinCategory"]) ?? "",
    subCategory: unq(a["PinType.PinSubCategory"]) ?? "",
    subCategoryObject: innerPath(unq(a["PinType.PinSubCategoryObject"])),
    container: unq(a["PinType.ContainerType"]) ?? "None",
    valueType: valueTypeOf(a["PinType.PinValueType"]),
    hidden: a["bHidden"] === "True",
    defaultValue: a["DefaultValue"] === undefined ? null : (unq(a["DefaultValue"]) ?? null),
    defaultObject,
    links: parseLinks(a["LinkedTo"]),
    raw: raw.trim(),
  };
}

function typeFromAttrs(a: Record<string, string>): string {
  const category = unq(a["PinCategory"]) ?? "";
  try {
    return bpTypeFromPin({
      category,
      subCategory: unq(a["PinSubCategory"]) ?? "",
      subCategoryObject: innerPath(unq(a["PinSubCategoryObject"])),
      container: a["ContainerType"] ?? "None",
      valueType: valueTypeOf(a["PinValueType"]),
    });
  } catch {
    return `unsupported:${category}${a["ContainerType"] && a["ContainerType"] !== "None" ? ":" + a["ContainerType"] : ""}`;
  }
}

const BEGIN = /^\s*Begin Object(?: Class=(\S+))? Name="([^"]+)"(?: ExportPath="([^']*)'([^']*)')?/;
const END = /^\s*End Object\b/;
const EVENT_GRAPH = "EventGraph";

export function parseExport(text: string): T3dExport {
  const lines = text.split(/\r?\n/);
  // Names used in the event graph: it always keeps the plain key, whatever order the engine lists the graphs in (a warm
  // export may list the generated per-event stub graphs first, whose node names collide with the event graph's).
  const eventGraphNames = new Set<string>();
  {
    const open: string[] = [];
    for (const line of lines) {
      const b = BEGIN.exec(line);
      if (b) {
        if (open.length === 2 && open[1] === EVENT_GRAPH) eventGraphNames.add(b[2] ?? "");
        open.push(b[2] ?? "");
      } else if (END.test(line)) open.pop();
    }
  }
  const nodes = new Map<string, T3dNode>();
  const byGraphName = new Map<string, string>(); // "<graph>\0<name>" -> key in `nodes`
  const variables: T3dExport["variables"] = [];
  let parentClass: string | null = null;
  // stack of open blocks: [0] root, [1] graphs, [2] nodes
  const stack: Array<{ name: string; node: T3dNode | null }> = [];
  for (const line of lines) {
    const b = BEGIN.exec(line);
    if (b) {
      const depth = stack.length;
      let node: T3dNode | null = null;
      if (depth === 2) {
        const graph = stack[1]?.name ?? null;
        const name = b[2] ?? "";
        const cls = b[1] ?? b[3] ?? "";
        const id = `${graph ?? ""}\0${name}`;
        let key = byGraphName.get(id);
        if (key === undefined) {
          const plain = graph === EVENT_GRAPH ? !nodes.has(name) : !nodes.has(name) && !eventGraphNames.has(name);
          key = plain ? name : `${graph ?? ""}/${name}`;
          byGraphName.set(id, key);
          nodes.set(key, { name, cls, graph, head: [], pins: [] });
        }
        node = nodes.get(key) ?? null;
        if (node && node.cls === "") node.cls = cls;
      }
      stack.push({ name: b[2] ?? "", node });
      continue;
    }
    if (END.test(line)) {
      stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    if (stack.length === 3 && top?.node) {
      const pin = parsePinLine(line);
      if (pin) top.node.pins.push(pin);
      else if (line.trim() !== "") top.node.head.push(line.trim());
      continue;
    }
    if (stack.length > 3) continue;
    const nv = /^\s*NewVariables\(\d+\)=\((.*)\)\s*$/.exec(line);
    if (nv && nv[1] !== undefined) {
      const a = parseAttrs(nv[1]);
      variables.push({
        name: unq(a["VarName"]) ?? "",
        type: typeFromAttrs(parseAttrs(unparen(a["VarType"]))),
        default: a["DefaultValue"] === undefined ? null : (unq(a["DefaultValue"]) ?? null),
        propertyFlags: a["PropertyFlags"] === undefined ? null : (unq(a["PropertyFlags"]) ?? null),
      });
      continue;
    }
    const pc = /^\s*ParentClass=(.*)$/.exec(line);
    if (pc && parentClass === null) parentClass = innerPath(unq(pc[1]?.trim()));
  }
  const widgets: T3dExport["widgets"] = [];
  for (const n of nodes.values()) {
    if (n.graph !== "WidgetTree" || n.cls === "" || /Slot$/.test(n.cls)) continue;
    widgets.push({ name: n.name, cls: n.cls, isVariable: n.head.includes("bIsVariable=True") });
  }
  return { nodes, variables, parentClass, widgets };
}

export function pinName(node: T3dNode, pinId: string): string | null {
  return node.pins.find((p) => p.id === pinId)?.name ?? null;
}

/** Parameters of a function or custom event entry node from its `UserDefinedPin` lines. */
export function userPins(node: T3dNode): { ins: Array<{ name: string; type: string }>; outs: Array<{ name: string; type: string }> } {
  const ins: Array<{ name: string; type: string }> = [];
  const outs: Array<{ name: string; type: string }> = [];
  for (const h of node.head) {
    const m = /^CustomProperties UserDefinedPin \((.*)\)\s*$/.exec(h);
    if (!m || m[1] === undefined) continue;
    const a = parseAttrs(m[1]);
    const pin = { name: unq(a["PinName"]) ?? "", type: typeFromAttrs(parseAttrs(unparen(a["PinType"]))) };
    (a["DesiredPinDirection"] === "EGPD_Output" ? outs : ins).push(pin);
  }
  return { ins, outs };
}

/**
 * Inner lines of the 3-space-indented `Begin Object ... Name="<graph>"` blocks (the class-header stub block and the body
 * block both match; their lines are concatenated, as the raw graph apply expects), with ` ExportPath="..."` removed.
 */
export function extractGraphBlock(text: string, graph: string): string {
  const ls = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const out: string[] = [];
  let found = false;
  const nameAttr = `Name="${graph}"`;
  for (let k = 0; k < ls.length; k++) {
    const l = ls[k] ?? "";
    if (l.startsWith("   Begin Object") && l.includes(nameAttr)) {
      found = true;
      let j = k + 1;
      while (j < ls.length && !(ls[j] ?? "").startsWith("   End Object")) j++;
      out.push(...ls.slice(k + 1, j));
    }
  }
  if (!found) throw new Error(`graph "${graph}" not found in the export`);
  return out.map((l) => l.replace(/ ExportPath="[^"]*"/, "")).join("\n");
}

/** Replace wildcard pin types in an extracted graph block (design: P5 two-phase fallback). */
export function patchWildcardPins(
  block: string,
  patches: Array<{ node: string; pin: string; type: string }>,
  classMeta: Record<string, string>,
): { text: string; patched: number } {
  const byNode = new Map<string, Map<string, string>>();
  for (const p of patches) {
    let m = byNode.get(p.node);
    if (!m) byNode.set(p.node, (m = new Map()));
    m.set(p.pin, p.type);
  }
  const WILD = 'PinType.PinCategory="wildcard",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None';
  let cur: string | null = null;
  let patched = 0;
  const text = block.split("\n").map((l) => {
    const b = BEGIN.exec(l);
    if (b) {
      cur = b[2] ?? null;
      return l;
    }
    if (END.test(l)) {
      cur = null;
      return l;
    }
    const pm = /CustomProperties Pin \(.*?PinName="([^"]+)",/.exec(l);
    const type = cur === null || !pm || pm[1] === undefined ? undefined : byNode.get(cur)?.get(pm[1]);
    if (type === undefined || !l.includes('PinType.PinCategory="wildcard"') || !l.includes(WILD)) return l;
    const t = parseBpType(type);
    const lineContainer = /PinType\.ContainerType=(\w+)/.exec(l)?.[1] ?? "None";
    if (lineContainer !== t.container) {
      throw new PatchError(`${cur}.${pm?.[1]}: pin container is ${lineContainer} but type "${type}" is ${t.container}`);
    }
    const kind = t.cat === "struct" ? "struct" : t.cat === "byte" && t.path ? "enum" : "object";
    const obj = t.path === null ? "None" : `"${pinObjectText(kind, t.path, classMeta)}"`;
    patched++;
    return l.replace(WILD, `PinType.PinCategory="${t.cat}",PinType.PinSubCategory="${t.sub}",PinType.PinSubCategoryObject=${obj}`);
  }).join("\n");
  return { text, patched };
}

const HEAD_KEEP = /^(FunctionReference|VariableReference|EventReference|CustomFunctionName|TargetType|StructType|bIsPureFunc)/;

/**
 * Hash of the semantic state of the named nodes: class, identity-bearing property lines and pins with their links.
 * Positions, GUIDs, pin ids and comment sizes are excluded.
 */
export function unitStateHash(nodes: Map<string, T3dNode>, names: string[]): string {
  const linkName = (l: { node: string; pinId: string }): string => {
    const target = nodes.get(l.node);
    return `${l.node}.${(target ? pinName(target, l.pinId) : null) ?? l.pinId}`;
  };
  const state = [...names].sort().map((name) => {
    const n = nodes.get(name);
    if (!n) return { missing: true };
    return {
      cls: n.cls,
      head: n.head.filter((h) => HEAD_KEEP.test(h)).map((h) => h.replace(/MemberGuid=[0-9A-F]{32},?/g, "")),
      pins: n.pins
        .map((p) => ({
          name: p.name,
          dir: p.dir,
          category: p.category,
          subCategory: p.subCategory,
          subCategoryObject: p.subCategoryObject,
          container: p.container,
          defaultValue: p.defaultValue,
          defaultObject: p.defaultObject,
          links: p.links.map(linkName).sort(),
        }))
        .sort((x, y) => (x.dir === y.dir ? 0 : x.dir < y.dir ? -1 : 1) || (x.name === y.name ? 0 : x.name < y.name ? -1 : 1) ||
          (canonicalJson(x) < canonicalJson(y) ? -1 : canonicalJson(x) > canonicalJson(y) ? 1 : 0)),
    };
  });
  return "sha256:" + sha256(canonicalJson(state));
}
