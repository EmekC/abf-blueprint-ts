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
  /**
   * Delegate links to or from another unit's entry node, recorded instead of refusing: `uses` = a data pin of an owned node is fed by
   * the entry `entry` (its OutputDelegate); `supplies` = a node of another unit takes this unit's entry as its delegate.
   */
  crossLinks: Array<{ node: string; pin: string; entry: string; role: "uses" | "supplies" }>;
  /** Nodes added with `--remove-node` (comment boxes and nodes without linked pins); they are removed together with the unit. */
  extra: string[];
}

export interface AdoptOptions {
  /** `override`: the entry is a `K2Node_Event` (engine event) named `unitName`; default `event`: a custom event. */
  kind?: "event" | "override";
  /** Extra nodes to remove with the unit (design 8.4); ABFC5008 unless a node is a comment or has no linked pin. */
  extraNodes?: string[];
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
/** A delegate pin (the `OutputDelegate` of an event, the `Delegate` input of SetTimer); event parameter pins are not. */
const isDelegatePin = (p: T3dNode["pins"][number]): boolean => p.category === "delegate";

export function analyzeAdoption(nodes: Map<string, T3dNode>, graph: string, unitName: string, opts: AdoptOptions = {}): AdoptionAnalysis {
  const byName = new Map<string, T3dNode>();
  for (const n of nodes.values()) if (n.graph === graph) byName.set(n.name, n);

  const override = opts.kind === "override";
  const start = override
    ? [...byName.values()]
        .filter((n) => shortCls(n) === "K2Node_Event" && n.head.some((h) => h.startsWith("EventReference=") && h.includes(`MemberName="${unitName}"`)))
        .find((n) => !n.head.includes("EnabledState=Disabled"))
    : [...byName.values()].find(
        (n) => shortCls(n) === "K2Node_CustomEvent" && n.head.some((h) => h === `CustomFunctionName="${unitName}"`),
      );
  if (!start && override) {
    throw new AdoptionError("ABFC5002", `no enabled override event "${unitName}" in graph "${graph}"`);
  }
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
  const extra: string[] = [];
  for (const name of opts.extraNodes ?? []) {
    const n = byName.get(name);
    if (!n) throw new AdoptionError("ABFC5008", `--remove-node: no node named "${name}" in graph "${graph}"`);
    if (!isComment(n) && n.pins.some((p) => p.links.length > 0)) {
      throw new AdoptionError("ABFC5008", `--remove-node: "${name}" is not a comment box and has linked pins; only comment boxes and unlinked nodes can be removed this way`);
    }
    if (!extra.includes(name)) extra.push(name);
    const at = shared.indexOf(name);
    if (at >= 0) shared.splice(at, 1);
    if (!owned.includes(name)) owned.push(name);
  }
  extra.sort();
  owned.sort();
  shared.sort();
  const ownedSet = new Set(owned);
  const foreignLinks: AdoptionAnalysis["foreignLinks"] = [];
  for (const n of byName.values()) {
    if (mine.has(n.name) || isComment(n)) continue;
    for (const p of n.pins) {
      if (isEntry(n) && p.dir === "out" && isDelegatePin(p)) continue; // another entry's delegate output: a crossLink, not a foreign link
      for (const l of p.links) {
        if (ownedSet.has(l.node) && l.node !== start.name) foreignLinks.push({ node: n.name, pin: p.name, to: l.node });
      }
    }
  }
  foreignLinks.sort((a, b) => (a.node + a.pin + a.to < b.node + b.pin + b.to ? -1 : 1));

  // Delegate links to other units' entries stop the reachability above (an entry has an exec pin, so it is never a feeder); they are recorded.
  const crossLinks: AdoptionAnalysis["crossLinks"] = [];
  for (const n of byName.values()) {
    if (isComment(n)) continue;
    for (const p of n.pins) {
      if (mine.has(n.name)) {
        if (p.dir !== "in" || !isDelegatePin(p)) continue;
        for (const l of p.links) {
          const t = byName.get(l.node);
          const from = t?.pins.find((q) => q.id === l.pinId);
          if (t && isEntry(t) && t.name !== start.name && from !== undefined && isDelegatePin(from)) {
            crossLinks.push({ node: n.name, pin: p.name, entry: t.name, role: "uses" });
          }
        }
      } else {
        for (const l of p.links) {
          if (l.node !== start.name) continue;
          const from = start.pins.find((q) => q.id === l.pinId);
          if (from !== undefined && isDelegatePin(from)) crossLinks.push({ node: n.name, pin: p.name, entry: start.name, role: "supplies" });
        }
      }
    }
  }
  crossLinks.sort((a, b) => (a.node + a.pin + a.entry < b.node + b.pin + b.entry ? -1 : 1));
  return { entry: start.name, owned, shared, foreignLinks, crossLinks, extra };
}

/**
 * ABFC5005 when the analysis shows shared nodes, foreign pin links, or a node outside every owned or adopted unit that takes this
 * unit's entry as its delegate (the build replaces the entry and would cut that hand-made link silently); empty when the unit can
 * be adopted. `otherUnitNodes` = the nodes recorded for the asset's other units (owned or adopted); a `supplies` link is accepted
 * only when its node is in that set (the other unit's build keeps or re-creates the link).
 */
export function adoptionDiagnostics(
  a: AdoptionAnalysis,
  asset: string,
  unitName: string,
  otherUnitNodes: ReadonlySet<string> = new Set<string>(),
): Diagnostic[] {
  const handMadeSuppliers = a.crossLinks.filter((c) => c.role === "supplies" && !otherUnitNodes.has(c.node));
  if (a.shared.length === 0 && a.foreignLinks.length === 0 && handMadeSuppliers.length === 0) return [];
  const parts: string[] = [];
  if (a.shared.length > 0) parts.push(`${a.shared.length} node(s) shared with other entries (${a.shared.join(", ")})`);
  if (a.foreignLinks.length > 0) {
    parts.push(`${a.foreignLinks.length} pin link(s) from other nodes (${a.foreignLinks.map((l) => `${l.node}.${l.pin}`).join(", ")})`);
  }
  if (handMadeSuppliers.length > 0) {
    parts.push(
      `${handMadeSuppliers.length} hand-made node(s) take this event as their delegate (${handMadeSuppliers.map((l) => `${l.node}.${l.pin}`).join(", ")}) and belong to no owned or adopted unit; a build would cut that link`,
    );
  }
  return [{
    severity: "error",
    code: "ABFC5005",
    asset,
    message: `cannot adopt ${unitName}: ${parts.join("; ")}.`,
    fix: "split the shared nodes in the editor, or adopt the unit that holds the delegate user first (or move that node into the unit), then run abfc adopt again.",
  }];
}
