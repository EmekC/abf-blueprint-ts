import { createHash } from "node:crypto";
import type { IrUnit } from "./types.js";

/** JSON with sorted object keys and no whitespace; arrays keep their order; `undefined` members are dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    const s = JSON.stringify(v);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(v)) return "[" + v.map((x) => canonicalJson(x)).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Hash of a unit's signature, nodes and wires; positions and origins are excluded. */
export function unitHash(u: IrUnit): string {
  return "sha256:" + sha256(canonicalJson({
    signature: u.signature,
    nodes: u.nodes.map(({ pos: _pos, origin: _origin, ...rest }) => rest),
    wires: u.wires,
  }));
}
