// Build planner: IR + manifests + stage snapshots -> the units to (re)apply, and the diagnostics that block others.
import type { ApplyPlan, AssetPlan, Diagnostic, IrModule, IrUnit, IrVariable, Span, T3dNode } from "@abfc/ir";
import { driftDiagnostics, unitState } from "../ownership/drift.js";
import type { StageInfo } from "../ownership/drift.js";
import type { Manifest, ManifestUnit } from "../ownership/manifest.js";

export interface PlanInput {
  manifests: Map<string, Manifest | null>;
  /** Parsed `bp_read` export per asset: node name -> node. */
  snapshots: Map<string, Map<string, T3dNode>>;
  stage: StageInfo;
  /** Names of hand-made units per asset (from the `_Manual` interface or the read-back). */
  handMadeUnits: Map<string, string[]>;
  /** Variable names present in each snapshot (temps already declared are not declared again). */
  snapshotVariables?: Map<string, string[]>;
}

export interface PlanResult {
  plan: ApplyPlan;
  diagnostics: Diagnostic[];
  /** `<asset> <unit id>` of the units that need nothing. */
  upToDate: string[];
}

const nodePos = (n: T3dNode): [number, number] => {
  let x = 0;
  let y = 0;
  for (const h of n.head) {
    const mx = /^NodePosX=(-?\d+)/.exec(h);
    const my = /^NodePosY=(-?\d+)/.exec(h);
    if (mx?.[1] !== undefined) x = Number(mx[1]);
    if (my?.[1] !== undefined) y = Number(my[1]);
  }
  return [x, y];
};

function hasHandMadeEvent(snapshot: Map<string, T3dNode>, name: string): boolean {
  for (const n of snapshot.values()) {
    if (n.cls.endsWith("K2Node_CustomEvent") && n.head.includes(`CustomFunctionName="${name}"`)) return true;
  }
  return false;
}

function unitHeight(u: IrUnit): number {
  return u.nodes.reduce((m, n) => Math.max(m, n.pos[1]), 0) + 300;
}

export function planBuild(ir: IrModule, input: PlanInput): PlanResult {
  const diagnostics: Diagnostic[] = [];
  const upToDate: string[] = [];
  const assets: AssetPlan[] = [];

  for (const asset of ir.assets) {
    const manifest = input.manifests.get(asset.path) ?? null;
    const snapshot = input.snapshots.get(asset.path) ?? new Map<string, T3dNode>();
    const handMade = input.handMadeUnits.get(asset.path) ?? [];
    const declared = new Set(input.snapshotVariables?.get(asset.path) ?? []);
    const spans = new Map<string, Span>(asset.units.map((u) => [u.id, u.origin]));

    const picked: Array<{ unit: IrUnit; removeNodes: string[] }> = [];
    for (const unit of asset.units) {
      const mu: ManifestUnit | undefined = manifest?.units.find((m) => m.id === unit.id);
      const state = mu ? unitState(mu, snapshot, input.stage) : null;

      if (!mu || state === "pendingApply") {
        if (!(mu?.adopt) && (handMade.includes(unit.name) || hasHandMadeEvent(snapshot, unit.name))) {
          diagnostics.push({
            severity: "error",
            code: "ABFC5003",
            asset: asset.path,
            span: unit.origin,
            message: `${unit.name} is declared in TypeScript but already exists as a hand-made event in ${asset.path.slice(asset.path.lastIndexOf("/") + 1)}.`,
            fix: `run: abfc adopt ${asset.path} ${unit.name}`,
          });
          continue;
        }
        picked.push({ unit, removeNodes: [] });
        continue;
      }

      const drift = driftDiagnostics(asset.path, [mu], snapshot, input.stage, spans);
      if (drift.length > 0) {
        diagnostics.push(...drift);
        continue;
      }
      if (state === "pendingAdoption" || state === "staleStage") {
        picked.push({ unit, removeNodes: [...(mu.adopt?.nodes ?? [])] });
      } else if (mu.irHash !== unit.hash) {
        picked.push({ unit, removeNodes: [...mu.nodes] });
      } else {
        upToDate.push(`${asset.path} ${unit.id}`);
      }
    }
    if (picked.length === 0) continue;

    const removedByGraph = new Map<string, Set<string>>();
    for (const p of picked) {
      const set = removedByGraph.get(p.unit.graph) ?? new Set<string>();
      for (const r of p.removeNodes) set.add(r);
      removedByGraph.set(p.unit.graph, set);
    }
    const graphNodes: AssetPlan["graphNodes"] = {};
    for (const n of snapshot.values()) {
      if (n.graph === null) continue;
      (graphNodes[n.graph] ??= []).push({ name: n.name, pos: nodePos(n) });
    }

    const placedBottom = new Map<string, number>();
    const units: AssetPlan["units"] = picked.map((p) => {
      const removed = removedByGraph.get(p.unit.graph) ?? new Set<string>();
      const remaining = (graphNodes[p.unit.graph] ?? []).filter((n) => !removed.has(n.name));
      const minX = remaining.length === 0 ? 0 : Math.min(...remaining.map((n) => n.pos[0]));
      const maxY = remaining.length === 0 ? 0 : Math.max(...remaining.map((n) => n.pos[1]));
      const y = Math.max(maxY, placedBottom.get(p.unit.graph) ?? -Infinity) + 600;
      placedBottom.set(p.unit.graph, y + unitHeight(p.unit));
      return { unit: p.unit, removeNodes: p.removeNodes, origin: [minX, y] as [number, number] };
    });

    const prefixes = picked.map((p) => `abfc_${p.unit.name}_`);
    const variables: IrVariable[] = asset.variables.filter(
      (v) => prefixes.some((pre) => v.name.startsWith(pre)) && !declared.has(v.name),
    );
    assets.push({ asset: asset.path, graphNodes, variables, units, classMeta: ir.classMeta });
  }

  return { plan: { mod: ir.mod, assets }, diagnostics, upToDate };
}
