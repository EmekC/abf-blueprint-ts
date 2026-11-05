import { parseBpType } from "./bptype.js";
import type { IrModule } from "./types.js";

const NODE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const RESERVED_IDS = new Set(["entry", "result", "in", "out"]);
const RESERVED_ENDPOINTS = new Set(["entry", "result"]);

/** Structural checks of an IR module. Returns human-readable problems (empty = valid). */
export function validateIrModule(m: IrModule): string[] {
  const problems: string[] = [];
  for (const asset of m.assets) {
    if (!asset.path.startsWith(`/${m.mod}/`)) problems.push(`asset ${asset.path}: path must start with /${m.mod}/`);
    for (const unit of asset.units) {
      const where = `${asset.path} ${unit.id}`;
      const ids = new Set<string>();
      for (const n of unit.nodes) {
        if (!NODE_ID.test(n.id)) problems.push(`${where}: node id "${n.id}" must match ${NODE_ID.source}`);
        else if (RESERVED_IDS.has(n.id)) problems.push(`${where}: node id "${n.id}" is reserved`);
        if (ids.has(n.id)) problems.push(`${where}: duplicate node id "${n.id}"`);
        ids.add(n.id);
        for (const [pin, type] of Object.entries(n.pinTypes ?? {})) {
          try {
            parseBpType(type);
          } catch (e) {
            problems.push(`${where}: node ${n.id} pinTypes.${pin}: ${(e as Error).message}`);
          }
        }
      }
      for (const wire of unit.wires) {
        for (const end of wire) {
          const dot = end.indexOf(".");
          const id = dot < 0 ? end : end.slice(0, dot);
          if (dot < 0 || dot === end.length - 1) problems.push(`${where}: wire endpoint "${end}" must be <node>.<pin>`);
          else if (!ids.has(id) && !RESERVED_ENDPOINTS.has(id)) problems.push(`${where}: wire endpoint "${end}" names an undeclared node`);
        }
      }
    }
  }
  return problems;
}
