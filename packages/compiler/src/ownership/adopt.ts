// Adoption analysis (design 8.4): which nodes of a hand-made unit belong to it alone.
import type { Diagnostic, T3dNode } from "@abfc/ir";

export interface AdoptionAnalysis {
  entry: string;
  /** Nodes reachable only from the entry (exec chain plus pure feeders), including the entry. */
  owned: string[];
  /** Nodes of the unit that another entry reaches as well. */
  shared: string[];
  /** Pin links from nodes outside the unit into owned non-entry nodes. */
  foreignLinks: Array<{ node: string; pin: string; to: string }>;
}

export class AdoptionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AdoptionError";
    this.code = code;
  }
}

const shortCls = (n: T3dNode): string => n.cls.slice(n.cls.lastIndexOf(".") + 1);
const isComment = (n: T3dNode): boolean => shortCls(n) === "EdGraphNode_Comment";
const isEntry = (n: T3dNode): boolean => /^(K2Node_CustomEvent|K2Node_Event|K2Node_FunctionEntry)$/.test(shortCls(n));
const hasExec = (n: T3dNode): boolean => n.pins.some((p) => p.category === "exec");

export function analyzeAdoption(nodes: Map<string, T3dNode>, graph: string, unitName: string): AdoptionAnalysis {
  const byName = new Map<string, T3dNode>();
  for (const n of nodes.values()) if (n.graph === graph) byName.set(n.name, n);

  const start = [...byName.values()].find(
    (n) => shortCls(n) === "K2Node_CustomEvent" && n.head.some((h) => h === `CustomFunctionName="${unitName}"`),
  );
  if (!start) {
    const isFunction = [...nodes.values()].some((n) => shortCls(n) === "K2Node_FunctionEntry" && n.graph === unitName);
    if (isFunction) throw new AdoptionError("ABFC2099", `"${unitName}" is a function; adopting functions is not supported in Phase 1`);
    throw new AdoptionError("ABFC5002", `no custom event named "${unitName}" in graph "${graph}"`);
  }

  const reach = (from: string): Set<string> => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length > 0) {
      const n = byName.get(queue.pop()!);
      if (!n) continue;
      for (const p of n.pins) {
        if (p.dir !== "out" || p.category !== "exec") continue;
        for (const l of p.links) {
          if (byName.has(l.node) && !seen.has(l.node)) {
            seen.add(l.node);
            queue.push(l.node);
          }
        }
      }
    }
    return seen;
  };
  const withFeeders = (set: Set<string>): Set<string> => {
    const res = new Set(set);
    const queue = [...set];
    while (queue.length > 0) {
      const n = byName.get(queue.pop()!);
      if (!n) continue;
      for (const p of n.pins) {
        if (p.dir !== "in" || p.category === "exec") continue;
        for (const l of p.links) {
          const t = byName.get(l.node);
          if (t && !hasExec(t) && !isComment(t) && !res.has(l.node)) {
            res.add(l.node);
            queue.push(l.node);
          }
        }
      }
    }
    return res;
  };

  const mine = withFeeders(reach(start.name));
  const others = new Set<string>();
  for (const n of byName.values()) {
    if (isEntry(n) && n.name !== start.name) for (const t of withFeeders(reach(n.name))) others.add(t);
  }
  const owned: string[] = [];
  const shared: string[] = [];
  for (const name of mine) {
    if (isComment(byName.get(name)!)) continue;
    (others.has(name) ? shared : owned).push(name);
  }
  owned.sort();
  shared.sort();
  const ownedSet = new Set(owned);
  const foreignLinks: AdoptionAnalysis["foreignLinks"] = [];
  for (const n of byName.values()) {
    if (mine.has(n.name) || isComment(n)) continue;
    for (const p of n.pins) {
      for (const l of p.links) {
        if (ownedSet.has(l.node) && l.node !== start.name) foreignLinks.push({ node: n.name, pin: p.name, to: l.node });
      }
    }
  }
  foreignLinks.sort((a, b) => (a.node + a.pin + a.to < b.node + b.pin + b.to ? -1 : 1));
  return { entry: start.name, owned, shared, foreignLinks };
}

/** ABFC5005 when the analysis shows shared nodes or foreign pin links; empty when the unit can be adopted. */
export function adoptionDiagnostics(a: AdoptionAnalysis, asset: string, unitName: string): Diagnostic[] {
  if (a.shared.length === 0 && a.foreignLinks.length === 0) return [];
  const parts: string[] = [];
  if (a.shared.length > 0) parts.push(`${a.shared.length} node(s) shared with other entries (${a.shared.join(", ")})`);
  if (a.foreignLinks.length > 0) {
    parts.push(`${a.foreignLinks.length} pin link(s) from other nodes (${a.foreignLinks.map((l) => `${l.node}.${l.pin}`).join(", ")})`);
  }
  return [{
    severity: "error",
    code: "ABFC5005",
    asset,
    message: `cannot adopt ${unitName}: ${parts.join("; ")}.`,
    fix: "split the shared nodes in the editor, then run abfc adopt again.",
  }];
}
