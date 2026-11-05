import type { HirUnit } from "../hir.js";
import type { IrModule } from "../../../ir/src/index.js";

export function lower(units: HirUnit[]): IrModule {
  return {
    irVersion: 1,
    profile: "ue5.4.4-1050002",
    mod: "spike",
    assets: [{ path: "/spike/BP_Sample", variables: [], units: units.map((u) => ({
      id: "event:" + u.name, kind: "event" as const, name: u.name, graph: "EventGraph",
      signature: { inputs: [], outputs: [] }, locals: [], nodes: [], wires: [],
      origin: u.nodes[0]?.span ?? { file: "", line: 0, col: 0, endLine: 0, endCol: 0 }, hash: "",
    })) }],
  };
}
