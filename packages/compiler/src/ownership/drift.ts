// Drift detection (design 8.3): is an owned unit in the stage still what abfc applied?
import { unitStateHash } from "@abfc/ir";
import type { Diagnostic, Span, T3dNode } from "@abfc/ir";
import type { ManifestUnit } from "./manifest.js";

/** The part of the backend's `StageStatus` the compiler needs. */
export interface StageInfo {
  syncedAt: string | null;
}

export type UnitState = "clean" | "edited" | "missing" | "pendingAdoption" | "pendingApply" | "staleStage";

export interface UnitFingerprint {
  assetHash: string;
  nodeHashes: Record<string, string>;
  /** Sorted `<node>.<pin> > <node>.<pin>` links of the owned nodes (owned -> any, and foreign -> owned). */
  links: string[];
}

function pinNameOf(nodes: Map<string, T3dNode>, node: string, pinId: string): string {
  return nodes.get(node)?.pins.find((p) => p.id === pinId)?.name ?? pinId;
}

/** Hash, per-node hashes and link list of the named nodes of a snapshot. */
export function fingerprintUnit(snapshot: Map<string, T3dNode>, names: string[]): UnitFingerprint {
  const owned = new Set(names);
  const nodeHashes: Record<string, string> = {};
  const links: string[] = [];
  for (const name of [...names].sort()) {
    nodeHashes[name] = unitStateHash(snapshot, [name]);
    const n = snapshot.get(name);
    if (!n) continue;
    for (const p of n.pins) {
      for (const l of p.links) {
        const other = `${l.node}.${pinNameOf(snapshot, l.node, l.pinId)}`;
        const mine = `${name}.${p.name}`;
        if (p.dir === "out") links.push(`${mine} > ${other}`);
        else if (!owned.has(l.node)) links.push(`${other} > ${mine}`);
      }
    }
  }
  links.sort();
  return { assetHash: unitStateHash(snapshot, names), nodeHashes, links };
}

export function unitState(unit: ManifestUnit, snapshot: Map<string, T3dNode>, stage: StageInfo): UnitState {
  if (unit.stageSyncedAt !== null && stage.syncedAt !== unit.stageSyncedAt) return "staleStage";
  if (unit.adopt !== null && unit.stageSyncedAt === null) return "pendingAdoption";
  if (unit.assetHash === null || unit.nodes.length === 0) return "pendingApply";
  if (unit.nodes.some((n) => !snapshot.has(n))) return "missing";
  return unitStateHash(snapshot, unit.nodes) === unit.assetHash ? "clean" : "edited";
}

/**
 * Was the unit applied by abfc and does the stage still hold exactly that applied graph? After a `--resync` from a published mod
 * the stage timestamp differs from the manifest, but the abfc-built nodes are what the stage holds.
 */
export function builtGraphMatches(unit: ManifestUnit, snapshot: Map<string, T3dNode>): boolean {
  if (unit.assetHash === null || unit.nodes.length === 0) return false;
  if (unit.nodes.some((n) => !snapshot.has(n))) return false;
  return unitStateHash(snapshot, unit.nodes) === unit.assetHash;
}

/** Same manifest units with `stageSyncedAt` moved to the current stage for the stale units whose built graph the stage still holds. */
export function rebaseStaleUnits<T extends { units: ManifestUnit[] }>(manifest: T, snapshot: Map<string, T3dNode>, stage: StageInfo): { manifest: T; changed: boolean } {
  let changed = false;
  const units = manifest.units.map((u) => {
    if (unitState(u, snapshot, stage) !== "staleStage" || !builtGraphMatches(u, snapshot)) return u;
    changed = true;
    return { ...u, stageSyncedAt: stage.syncedAt };
  });
  return { manifest: changed ? { ...manifest, units } : manifest, changed };
}

function unitLabel(asset: string, unitId: string): string {
  const short = asset.slice(asset.lastIndexOf("/") + 1);
  const colon = unitId.indexOf(":");
  const kind = colon < 0 ? "unit" : unitId.slice(0, colon);
  return `${short} ${kind} ${colon < 0 ? unitId : unitId.slice(colon + 1)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** ABFC5001 / ABFC5002 / ABFC5004 for the units whose stage state forbids replacing them. */
export function driftDiagnostics(
  asset: string,
  units: ManifestUnit[],
  snapshot: Map<string, T3dNode>,
  stage: StageInfo,
  spans: Map<string, Span>,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const unit of units) {
    const label = unitLabel(asset, unit.id);
    const base = { severity: "error" as const, asset, ...(spans.has(unit.id) ? { span: spans.get(unit.id)! } : {}) };
    const state = unitState(unit, snapshot, stage);
    if (state === "missing") {
      const gone = unit.nodes.filter((n) => !snapshot.has(n));
      out.push({
        ...base,
        code: "ABFC5002",
        message: `${label}: ${plural(gone.length, "owned node")} missing in the asset (${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", ..." : ""}). abfc will not overwrite it.`,
        fix: "undo the deletion in the editor, or restore the stage with abfc build --resync after reverting the unit in the real mod.",
      });
    } else if (state === "edited") {
      const fp = fingerprintUnit(snapshot, unit.nodes);
      let counts = "";
      if (unit.nodeHashes && unit.links) {
        const changed = unit.nodes.filter((n) => fp.nodeHashes[n] !== unit.nodeHashes![n]).length;
        const was = new Set(unit.links);
        const now = new Set(fp.links);
        const added = fp.links.filter((l) => !was.has(l)).length;
        const removed = unit.links.filter((l) => !now.has(l)).length;
        counts = ` (${plural(changed, "node")} changed, ${plural(added, "link")} added, ${plural(removed, "link")} removed)`;
      }
      out.push({
        ...base,
        code: "ABFC5001",
        message: `${label} was edited in the editor since the last build${counts}. abfc will not overwrite it.`,
        fix: `undo the edit in the editor, or move it into the .ts file and run: abfc adopt ${asset} ${unit.id} --yes --discard-editor-changes (the next build then replaces the edited nodes)`,
      });
    } else if (state === "staleStage" && builtGraphMatches(unit, snapshot)) {
      continue; // re-synced from a published mod that holds the abfc-built graph
    } else if (state === "staleStage" && unit.adopt === null) {
      const gone = unit.nodes.filter((n) => !snapshot.has(n));
      if (gone.length > 0) {
        out.push({
          ...base,
          code: "ABFC5002",
          message: `${label}: the stage was re-synced and ${plural(gone.length, "owned node")} ${gone.length === 1 ? "is" : "are"} missing in the asset (${gone.slice(0, 5).join(", ")}${gone.length > 5 ? ", ..." : ""}). abfc will not overwrite it.`,
          fix: "restore the unit in the real mod, or run abfc build --resync after reverting it.",
        });
      } else if (unit.assetHash !== null && unit.nodes.length > 0) {
        out.push({
          ...base,
          code: "ABFC5001",
          message: `${label} differs from what abfc applied (the stage was re-synced from the real mod). abfc will not overwrite it.`,
          fix: `move the change into the .ts file and run: abfc adopt ${asset} ${unit.id} --yes --discard-editor-changes`,
        });
      }
    } else if ((state === "pendingAdoption" || state === "staleStage") && unit.adopt !== null) {
      if (unitStateHash(snapshot, unit.adopt.nodes) !== unit.adopt.hash) {
        out.push({
          ...base,
          code: "ABFC5004",
          message: `${label}: the hand-made unit adopted earlier changed in the real mod (the staged copy no longer matches the recorded adoption hash).`,
          fix: "review the change in the editor, then run abfc adopt again for this unit.",
        });
      }
    }
  }
  return out;
}
