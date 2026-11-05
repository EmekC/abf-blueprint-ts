import { randomBytes } from "node:crypto";
import type { IrNode } from "./types.js";

/**
 * T3D block of a node without pins (design 6.1), for text backends. `guid` defaults to a fresh random NodeGuid
 * (32 uppercase hex digits).
 */
export function renderT3D(node: IrNode, name: string, guid?: string): string {
  const g = guid ?? randomBytes(16).toString("hex").toUpperCase();
  return [
    `Begin Object Class=${node.t3d.class} Name="${name}"`,
    ...node.t3d.props.map((p) => `   ${p}`),
    `   NodePosX=${Math.round(node.pos[0])}`,
    `   NodePosY=${Math.round(node.pos[1])}`,
    `   NodeGuid=${g}`,
    "End Object",
  ].join("\n");
}
