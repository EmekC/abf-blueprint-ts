// IR -> human text for editor hovers: which Blueprint nodes does a source position produce?
import type { IrModule, IrNode, Span } from "@abfc/ir";

/** Text after the last `.` (a class path `/Script/Engine.Actor` -> `Actor`); the whole text when there is no `.`. */
const shortName = (path: string): string => {
  const i = path.lastIndexOf(".");
  return i < 0 ? path : path.slice(i + 1);
};

/** Strips a trailing `_C` of a generated-class path name. */
const shortClass = (path: string): string => shortName(path).replace(/_C$/, "");

/** Span size as a sortable pair: lines first, then columns. */
function sizeOf(s: Span): [number, number] {
  return [s.endLine - s.line, s.endLine === s.line ? s.endCol - s.col : s.endCol];
}

/** 1-based (line, col) lies in `s`: inclusive start, exclusive end. */
function contains(s: Span, line: number, col: number): boolean {
  if (line < s.line || line > s.endLine) return false;
  if (line === s.line && col < s.col) return false;
  if (line === s.endLine && col >= s.endCol) return false;
  return true;
}

/**
 * The nodes whose source span contains (line, col) in `file` (1-based, project-relative with forward slashes).
 * When none does, the nodes written on that line. Smallest span first, then emission order.
 */
export function irNodesAt(ir: IrModule, file: string, line: number, col: number): IrNode[] {
  const all: Array<{ node: IrNode; order: number }> = [];
  let order = 0;
  for (const asset of ir.assets) {
    for (const unit of asset.units) {
      if (unit.origin.file !== file) continue;
      for (const node of unit.nodes) all.push({ node, order: order++ });
    }
  }
  let hits = all.filter((x) => x.node.origin.file === file && contains(x.node.origin, line, col));
  if (hits.length === 0) hits = all.filter((x) => x.node.origin.file === file && x.node.origin.line === line);
  hits.sort((a, b) => {
    const sa = sizeOf(a.node.origin);
    const sb = sizeOf(b.node.origin);
    return sa[0] - sb[0] || sa[1] - sb[1] || a.order - b.order;
  });
  return hits.map((x) => x.node);
}

/** A node as the node editor would name it, e.g. `Cast To Actor` or `Call KismetMathLibrary.Add_IntInt (pure)`. */
export function describeIrNode(n: IrNode): string {
  const s = n.sem;
  if (s === undefined) {
    const base = shortName(n.t3d.class).replace(/^K2Node_/, "");
    let member: string | undefined;
    for (const p of n.t3d.props) {
      const m = /MemberName="([^"]+)"/.exec(p);
      if (m !== null) {
        member = m[1];
        break;
      }
    }
    return member === undefined ? base : `${base} ${member}`;
  }
  switch (s.k) {
    case "call": {
      const pure = n.t3d.props.some((p) => p.replace(/\s/g, "") === "bIsPureFunc=True");
      return `Call ${s.class === undefined ? "Self" : shortClass(s.class)}.${s.function}${pure ? " (pure)" : ""}`;
    }
    case "get":
      return `Get ${s.name}`;
    case "set":
      return `Set ${s.name}`;
    case "event":
      return `Custom Event ${s.name}`;
    case "override":
      return `Event ${s.function}`;
    case "branch":
      return "Branch";
    case "sequence":
      return "Sequence";
    case "cast":
      return `Cast To ${shortClass(s.target)}`;
    case "self":
      return "Self";
    case "spawn":
      return "Spawn Actor from Class";
    case "create_widget":
      return "Create Widget";
    case "call_dispatcher":
      return `Call ${s.name}`;
    case "bind_dispatcher":
      return `Bind Event to ${s.name}`;
  }
}
