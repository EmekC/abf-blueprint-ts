// Build planner: IR + manifests + stage snapshots -> the units to (re)apply, and the diagnostics that block others.
import { classDefaultsHash } from "@abfc/ir";
import type { ApplyPlan, AssetPlan, Diagnostic, IrModule, IrUnit, IrVariable, Span, T3dNode } from "@abfc/ir";
import { builtGraphMatches, driftDiagnostics, unitState } from "../ownership/drift.js";
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
  /** `<asset path> <unit id>` of units to re-plan although their IR hash is unchanged (compiler or stub lock changed). */
  forceReplan?: Set<string>;
  /** The backend's bp_apply feature `self_event_calls` (default true). Without it a self call to an event added in the same build cannot be applied. */
  selfEventCalls?: boolean;
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

function hasHandMadeEvent(snapshot: Map<string, T3dNode>, name: string, kind: IrUnit["kind"] = "event"): boolean {
  for (const n of snapshot.values()) {
    if (kind === "override") {
      // a disabled engine default node (an unused ReceiveBeginPlay) is not hand-made logic
      if (n.cls.endsWith("K2Node_Event") && n.head.some((h) => h.startsWith("EventReference=") && h.includes(`MemberName="${name}"`)) && !n.head.includes("EnabledState=Disabled")) return true;
    } else if (n.cls.endsWith("K2Node_CustomEvent") && n.head.includes(`CustomFunctionName="${name}"`)) return true;
  }
  return false;
}

/** Unit id of an abfc ownership tag comment (the format `renderTagSpec` writes), or null for any other node. */
function tagUnitOf(n: T3dNode): string | null {
  if (!n.cls.endsWith("EdGraphNode_Comment")) return null;
  for (const h of n.head) {
    const m = /^NodeComment="abfc:owned unit=(\S+) src=/.exec(h);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

/** Names of the abfc tag comments of one unit in one graph of the snapshot (a comment that is not provably that unit's tag is never listed). */
function tagsOf(snapshot: Map<string, T3dNode>, unitId: string, graph: string): string[] {
  const out: string[] = [];
  for (const n of snapshot.values()) if (n.graph === graph && tagUnitOf(n) === unitId) out.push(n.name);
  return out;
}

/** Does the asset's class defaults pass need to run (hash or stage changed)? */
function defaultsStale(asset: IrModule["assets"][number], manifest: Manifest | null, stage: StageInfo): boolean {
  if (asset.classDefaults === undefined && asset.classManagerRow === undefined) return false;
  const hash = classDefaultsHash(asset.classDefaults ?? {}, asset.classManagerRow);
  return manifest?.classDefaultsHash !== hash || (manifest.classDefaultsStageSyncedAt ?? null) !== stage.syncedAt;
}

/**
 * The assets that need a `bp_read` before planning: some unit is new, changed, forced, adopted but not applied, applied to an
 * older stage, or the class defaults changed. For any other asset nothing would be planned, so the read (and its drift check)
 * is skipped; `abfc status` still reads everything.
 */
export function assetsNeedingRead(
  ir: IrModule,
  input: { manifests: Map<string, Manifest | null>; stage: StageInfo; forceReplan?: Set<string> },
): Set<string> {
  const out = new Set<string>();
  for (const asset of ir.assets) {
    const manifest = input.manifests.get(asset.path) ?? null;
    const need =
      asset.units.some((unit) => {
        const mu = manifest?.units.find((m) => m.id === unit.id);
        return (
          !mu ||
          mu.irHash !== unit.hash ||
          input.forceReplan?.has(`${asset.path} ${unit.id}`) === true ||
          (mu.stageSyncedAt !== null && input.stage.syncedAt !== mu.stageSyncedAt) ||
          (mu.adopt !== null && mu.stageSyncedAt === null) ||
          mu.assetHash === null ||
          mu.nodes.length === 0
        );
      }) ||
      // a unit that is no longer in the TS: its stage nodes are removed (or its manifest entry dropped)
      (manifest?.units.some((mu) => !asset.units.some((unit) => unit.id === mu.id)) ?? false) ||
      defaultsStale(asset, manifest, input.stage);
    if (need) out.add(asset.path);
  }
  return out;
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
    /** Names of events that this build adds (no custom event in the stage yet). */
    const newEvents = new Set<string>();
    for (const unit of asset.units) {
      const mu: ManifestUnit | undefined = manifest?.units.find((m) => m.id === unit.id);
      let state = mu ? unitState(mu, snapshot, input.stage) : null;
      // A stage re-synced from a published mod that holds the abfc-built graph: the unit is as clean as before the resync.
      if (mu && state === "staleStage" && builtGraphMatches(mu, snapshot)) state = "clean";

      if (!mu || state === "pendingApply") {
        if (!(mu?.adopt) && (handMade.includes(unit.name) || hasHandMadeEvent(snapshot, unit.name, unit.kind))) {
          diagnostics.push({
            severity: "error",
            code: "ABFC5003",
            asset: asset.path,
            span: unit.origin,
            message: `${unit.name} is declared in TypeScript but already exists as a hand-made event in ${asset.path.slice(asset.path.lastIndexOf("/") + 1)}.`,
            fix: `run: abfc adopt ${asset.path} ${unit.kind === "override" ? "override:" : ""}${unit.name}`,
          });
          continue;
        }
        if (unit.kind === "event" && !hasHandMadeEvent(snapshot, unit.name)) newEvents.add(unit.name);
        // a manifest unit that was never applied records no tag, but may still have left some
        picked.push({ unit, removeNodes: mu ? tagsOf(snapshot, mu.id, mu.graph) : [] });
        continue;
      }

      const drift = driftDiagnostics(asset.path, [mu], snapshot, input.stage, spans);
      if (drift.length > 0) {
        diagnostics.push(...drift);
        continue;
      }
      if (state === "pendingAdoption" || state === "staleStage") {
        picked.push({ unit, removeNodes: [...(mu.adopt?.nodes ?? []), ...tagsOf(snapshot, mu.id, mu.graph)] });
      } else if (mu.irHash !== unit.hash || input.forceReplan?.has(`${asset.path} ${unit.id}`) === true) {
        // the old tag comment (and any orphan of it) goes with the unit's nodes; the tag pass writes the new one
        picked.push({ unit, removeNodes: [...mu.nodes, ...tagsOf(snapshot, mu.id, mu.graph)] });
      } else {
        upToDate.push(`${asset.path} ${unit.id}`);
      }
    }

    // Manifest units that are no longer in the TS (event removed or renamed).
    const removeUnits: NonNullable<AssetPlan["removeUnits"]> = [];
    const forgetUnits: string[] = [];
    const leftoverTags: Array<{ graph: string; nodes: string[] }> = []; // abfc tag comments a never-applied unit left on the stage
    for (const mu of manifest?.units ?? []) {
      if (asset.units.some((u) => u.id === mu.id)) continue;
      let state = unitState(mu, snapshot, input.stage);
      if (state === "staleStage" && builtGraphMatches(mu, snapshot)) state = "clean";
      if (state === "clean") {
        removeUnits.push({ id: mu.id, graph: mu.graph, nodes: [...mu.nodes, ...tagsOf(snapshot, mu.id, mu.graph)] });
      } else if (state === "pendingApply" || state === "pendingAdoption") {
        forgetUnits.push(mu.id);
        const left = tagsOf(snapshot, mu.id, mu.graph);
        if (left.length > 0) leftoverTags.push({ graph: mu.graph, nodes: left });
      } else {
        const drift = driftDiagnostics(asset.path, [mu], snapshot, input.stage, new Map<string, Span>());
        if (drift.length > 0) diagnostics.push(...drift);
        else forgetUnits.push(mu.id); // adopted hand-made nodes of a stale stage: nothing of abfc's to remove
      }
    }

    // Delegate owners: a unit with a cross wire into a planned unit loses that wire when the target is replaced, so it is replanned too.
    const pickedIds = new Set(picked.map((p) => p.unit.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const unit of asset.units) {
        if (pickedIds.has(unit.id) || !(unit.crossWires ?? []).some((w) => pickedIds.has(w.toUnit))) continue;
        const mu = manifest?.units.find((m) => m.id === unit.id);
        if (!mu || !upToDate.includes(`${asset.path} ${unit.id}`)) continue; // blocked by a diagnostic, or not applied yet (then it is picked anyway)
        picked.push({ unit, removeNodes: [...mu.nodes, ...tagsOf(snapshot, mu.id, mu.graph)] });
        pickedIds.add(unit.id);
        upToDate.splice(upToDate.indexOf(`${asset.path} ${unit.id}`), 1);
        grew = true;
      }
    }

    // Orphan tags: abfc tag comments of a unit that stays as it is, other than the one the manifest records (an earlier re-plan left them).
    // Only provable tags of a unit the manifest owns are removed, and only when the recorded tag is itself on the stage, so the unit keeps one.
    const removeTags: NonNullable<AssetPlan["removeTags"]> = [];
    for (const lt of leftoverTags) {
      const entry = removeTags.find((r) => r.graph === lt.graph);
      if (entry) entry.nodes.push(...lt.nodes);
      else removeTags.push({ graph: lt.graph, nodes: [...lt.nodes] });
    }
    for (const mu of manifest?.units ?? []) {
      if (pickedIds.has(mu.id) || !asset.units.some((u) => u.id === mu.id) || mu.tag === null) continue;
      const tags = tagsOf(snapshot, mu.id, mu.graph);
      if (!tags.includes(mu.tag)) continue;
      const orphans = tags.filter((t) => t !== mu.tag);
      if (orphans.length === 0) continue;
      const entry = removeTags.find((r) => r.graph === mu.graph);
      if (entry) entry.nodes.push(...orphans);
      else removeTags.push({ graph: mu.graph, nodes: orphans });
    }

    // Backends without `self_event_calls` cannot template a call to an event added in this very apply.
    if (input.selfEventCalls === false && newEvents.size > 0) {
      for (const p of picked) {
        for (const n of p.unit.nodes) {
          const sem = n.sem;
          if (sem?.k !== "call" || sem.class !== undefined || !newEvents.has(sem.function)) continue;
          diagnostics.push({
            severity: "error",
            code: "ABFC4013",
            asset: asset.path,
            span: n.origin,
            message: `calling ${sem.function} needs a backend with bp_apply feature self_event_calls (the event is new in this build)`,
            fix: "update abf-mod-editor-mcp, or build once without the call and add it in a second build",
          });
        }
      }
    }

    let defaults: AssetPlan["defaults"];
    if (asset.classDefaults !== undefined || asset.classManagerRow !== undefined) {
      const values = asset.classDefaults ?? {};
      const hash = classDefaultsHash(values, asset.classManagerRow);
      if (defaultsStale(asset, manifest, input.stage)) {
        defaults = {
          classPath: `${asset.path}.${asset.path.slice(asset.path.lastIndexOf("/") + 1)}_C`,
          values,
          hash,
          ...(asset.classManagerRow !== undefined ? { classManagerRow: asset.classManagerRow } : {}),
        };
      }
    }
    if (picked.length === 0 && defaults === undefined && removeUnits.length === 0 && forgetUnits.length === 0 && removeTags.length === 0) continue;

    const removedByGraph = new Map<string, Set<string>>();
    for (const r of removeUnits) {
      const set = removedByGraph.get(r.graph) ?? new Set<string>();
      for (const name of r.nodes) set.add(name);
      removedByGraph.set(r.graph, set);
    }
    for (const r of removeTags) {
      const set = removedByGraph.get(r.graph) ?? new Set<string>();
      for (const name of r.nodes) set.add(name);
      removedByGraph.set(r.graph, set);
    }
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
    // Entry nodes of cross wire targets that stay as they are: their real names come from the manifest.
    const entryNames: Record<string, string> = {};
    for (const p of picked) {
      for (const w of p.unit.crossWires ?? []) {
        if (pickedIds.has(w.toUnit)) continue;
        const real = manifest?.units.find((m) => m.id === w.toUnit)?.nodeIds[w.from.slice(0, w.from.indexOf("."))];
        if (real !== undefined) entryNames[w.toUnit] = real;
      }
    }
    assets.push({
      asset: asset.path,
      graphNodes,
      variables,
      units,
      classMeta: ir.classMeta,
      ...(Object.keys(entryNames).length > 0 ? { entryNames } : {}),
      ...(defaults !== undefined ? { defaults } : {}),
      ...(removeUnits.length > 0 ? { removeUnits } : {}),
      ...(forgetUnits.length > 0 ? { forgetUnits } : {}),
      ...(removeTags.length > 0 ? { removeTags } : {}),
    });
  }

  return { plan: { mod: ir.mod, assets }, diagnostics, upToDate };
}
