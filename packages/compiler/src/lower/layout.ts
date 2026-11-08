// Node placement (design 6.3): columns follow exec depth, pure nodes sit left of their first consumer.
import type { IrUnit } from "@abfc/ir";

const COL_W = 350;
const ROW_H = 220;

const idOf = (end: string): string => end.slice(0, end.indexOf("."));
const pinOf = (end: string): string => end.slice(end.indexOf(".") + 1);

/**
 * Sets `pos` of every node of the unit. Column = longest exec path from the entry (back-edges skipped);
 * a node without exec wires sits one column left of its leftmost consumer; rows follow emission order per column.
 */
export function assignPositions(unit: IrUnit, executePin = "execute"): void {
  const adj = new Map<string, string[]>();
  const execNodes = new Set<string>();
  // a ForEachLoop instance takes its exec input on `Exec` and ForLoopWithBreak on `Execute`, not on the profile's execute pin (ForLoop already uses `execute`)
  const macroIds = new Set(unit.nodes.filter((n) => n.sem?.k === "std_macro").map((n) => n.id));
  for (const [from, to] of unit.wires) {
    if (pinOf(to) !== executePin && !(macroIds.has(idOf(to)) && (pinOf(to) === "Exec" || pinOf(to) === "Execute"))) continue;
    const a = idOf(from);
    const b = idOf(to);
    execNodes.add(a);
    execNodes.add(b);
    const list = adj.get(a);
    if (list) list.push(b);
    else adj.set(a, [b]);
  }

  const entry = (unit.nodes.find((n) => n.sem?.k === "event" || n.sem?.k === "override") ?? unit.nodes[0])?.id;
  const col = new Map<string, number>();
  if (entry !== undefined) {
    const color = new Map<string, 1 | 2>();
    const forward = new Map<string, string[]>();
    const post: string[] = [];
    const dfs = (n: string): void => {
      color.set(n, 1);
      for (const m of adj.get(n) ?? []) {
        if (color.get(m) === 1) continue; // back-edge
        const list = forward.get(n);
        if (list) list.push(m);
        else forward.set(n, [m]);
        if (!color.has(m)) dfs(m);
      }
      color.set(n, 2);
      post.push(n);
    };
    dfs(entry);
    col.set(entry, 0);
    for (const n of [...post].reverse()) {
      const c = col.get(n) ?? 0;
      for (const m of forward.get(n) ?? []) col.set(m, Math.max(col.get(m) ?? 0, c + 1));
    }
  }
  for (const n of unit.nodes) if (execNodes.has(n.id) && !col.has(n.id)) col.set(n.id, 0);

  const consumers = new Map<string, string[]>();
  for (const [from, to] of unit.wires) {
    const a = idOf(from);
    const b = idOf(to);
    if (a === b) continue;
    const list = consumers.get(a);
    if (list) list.push(b);
    else consumers.set(a, [b]);
  }
  const visiting = new Set<string>();
  const colOf = (id: string): number => {
    const known = col.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const cs = (consumers.get(id) ?? []).map(colOf);
    visiting.delete(id);
    const c = cs.length === 0 ? 0 : Math.min(...cs) - 1;
    col.set(id, c);
    return c;
  };
  for (const n of unit.nodes) colOf(n.id);

  const min = Math.min(0, ...[...col.values()]);
  const rows = new Map<number, number>();
  for (const n of unit.nodes) {
    const c = (col.get(n.id) ?? 0) - min;
    const r = rows.get(c) ?? 0;
    rows.set(c, r + 1);
    n.pos = [c * COL_W, r * ROW_H];
  }
}
