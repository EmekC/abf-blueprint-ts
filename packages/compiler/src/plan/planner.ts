// Build planner: IR + manifests + stage snapshots -> the units to (re)apply, and the diagnostics that block others.
import { classDefaultsHash, structFieldsHash } from "@abfc/ir";
import type { ApplyPlan, AssetPlan, Diagnostic, IrModule, IrUnit, IrVariable, Span, T3dNode } from "@abfc/ir";
import { builtGraphMatches, driftDiagnostics, unitState } from "../ownership/drift.js";
import { analyzeAdoption } from "../ownership/adopt.js";
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
  /** Variable name -> type string (`parseExport().variables`) per asset: a delegate (`unsupported:mcdelegate`) is an event dispatcher, which is always kept. */
  snapshotVariableTypes?: Map<string, Map<string, string>>;
  /** `<asset path> <unit id>` of units to re-plan although their IR hash is unchanged (compiler or stub lock changed). */
  forceReplan?: Set<string>;
  /** The backend's bp_apply feature `self_event_calls` (default true). Without it a self call to an event added in the same build cannot be applied. */
  selfEventCalls?: boolean;
  /** Assets of `ir` whose file does not exist in the stage: they are created by the apply (an empty snapshot, every unit planned, the manifest ignored). */
  missing?: Set<string>;
  /** The backend capability `createKinds`; when given, creating an asset of a kind it lacks is ABFC2044. */
  createKinds?: string[];
  /** The backend writes class-manager rows (capability `classManagerRows`): a `@director` asset whose manifest has no `directorRow` for it re-runs the defaults pass. */
  directorRows?: boolean;
  /** Assets (paths) of hybrid classes (the TS class merges with a `<X>_Manual` interface): hand-made members are kept there (design 13). */
  hybrid?: Set<string>;
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

/** A call node whose function is `name` of the asset's own class (self context). */
function callsOwnFunction(n: T3dNode, name: string): boolean {
  return n.head.some((h) => h.startsWith("FunctionReference=") && h.includes(`MemberName="${name}"`) && h.includes("bSelfContext=True"));
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
function defaultsStale(asset: IrModule["assets"][number], manifest: Manifest | null, stage: StageInfo, directorRows = false): boolean {
  // The `@director` is gone but the manifest still records its row: the pass runs once more so the build can clear the record.
  if (manifest?.directorRow !== undefined && asset.director === undefined) return true;
  if (asset.classDefaults === undefined && asset.classManagerRow === undefined && asset.director === undefined) return false;
  const hash = classDefaultsHash(asset.classDefaults ?? {}, asset.classManagerRow, asset.director?.asset, asset.director?.tag);
  if (manifest?.classDefaultsHash !== hash || (manifest.classDefaultsStageSyncedAt ?? null) !== stage.syncedAt) return true;
  // The backend can write class-manager rows now but the last pass only verified the row (or wrote another one): run the pass again.
  return directorRows && asset.director !== undefined && manifest.directorRow !== asset.director.asset;
}

/**
 * The assets that need a `bp_read` before planning: some unit is new, changed, forced, adopted but not applied, applied to an
 * older stage, or the class defaults changed. For any other asset nothing would be planned, so the read (and its drift check)
 * is skipped; `abfc status` still reads everything.
 */
export function assetsNeedingRead(
  ir: IrModule,
  input: { manifests: Map<string, Manifest | null>; stage: StageInfo; forceReplan?: Set<string>; directorRows?: boolean },
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
      defaultsStale(asset, manifest, input.stage, input.directorRows === true) ||
      fieldsStale(asset, manifest);
    if (need) out.add(asset.path);
  }
  return out;
}

/** Own fields (non-temp variables) of the asset that differ from what the manifest recorded (new, retyped or gone from the TS). */
function fieldsStale(asset: IrModule["assets"][number], manifest: Manifest | null): boolean {
  const fields = asset.variables.filter((v) => v.temp !== true);
  if (fields.some((v) => manifest?.variables.find((m) => m.name === v.name)?.type !== v.type)) return true;
  return (manifest?.variables ?? []).some((m) => !m.name.startsWith("abfc_") && !fields.some((v) => v.name === m.name));
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function unitHeight(u: IrUnit): number {
  return u.nodes.reduce((m, n) => Math.max(m, n.pos[1]), 0) + 300;
}

export function planBuild(ir: IrModule, input: PlanInput): PlanResult {
  const diagnostics: Diagnostic[] = [];
  const upToDate: string[] = [];
  const assets: AssetPlan[] = [];

  for (const asset of ir.assets) {
    if (asset.structFields !== undefined) {
      // A mod-defined struct: created (never read) when the stage lacks it or the manifest does not know it; the backend no-ops an equal struct.
      const fields = asset.structFields;
      const hash = structFieldsHash(fields);
      const known = (input.manifests.get(asset.path) ?? null)?.structFieldsHash;
      const name = asset.path.slice(asset.path.lastIndexOf("/") + 1);
      // A struct missing from the stage (a stage reset) is planned as a fresh create whatever the manifest says.
      if (known !== undefined && known !== hash && input.missing?.has(asset.path) !== true) {
        diagnostics.push({
          severity: "error",
          code: "ABFC2046",
          asset: asset.path,
          ...(fields[0] !== undefined ? { span: fields[0].origin } : {}),
          message: `changing the fields of @struct ${name} after it was created is not supported yet.`,
          fix: "restore the fields, or give the struct a new path (and change the places that use it).",
        });
        continue;
      }
      if (input.createKinds !== undefined && !input.createKinds.includes("UserDefinedStruct")) {
        diagnostics.push({
          severity: "error",
          code: "ABFC2044",
          asset: asset.path,
          message: `${asset.path} is a @struct and the backend cannot create a UserDefinedStruct (backend_info bpApply createKinds).`,
          fix: "update abf-mod-editor-mcp (bp_apply feature struct_fields).",
        });
        continue;
      }
      if (known === hash && input.missing?.has(asset.path) !== true) continue;
      assets.push({ asset: asset.path, struct: { fields }, graphNodes: {}, variables: [], units: [], classMeta: ir.classMeta });
      continue;
    }
    let create: AssetPlan["create"];
    if (input.missing?.has(asset.path) === true && asset.create !== undefined) {
      const kind = asset.create.kind;
      if (kind !== "Blueprint" && kind !== "WidgetBlueprint") {
        diagnostics.push({ severity: "error", code: "ABFC2044", asset: asset.path, message: `${asset.path} does not exist in the stage and abfc cannot create a ${kind}.` });
        continue;
      }
      if (input.createKinds !== undefined && !input.createKinds.includes(kind)) {
        diagnostics.push({
          severity: "error",
          code: "ABFC2044",
          asset: asset.path,
          message: `${asset.path} does not exist in the stage and the backend cannot create a ${kind} (backend_info bpApply createKinds).`,
          fix: "update abf-mod-editor-mcp, or create the asset in the Mod Editor first.",
        });
        continue;
      }
      create = { class: kind, parent: asset.create.parent };
    }
    const manifest = create !== undefined ? null : (input.manifests.get(asset.path) ?? null);
    const snapshot = input.snapshots.get(asset.path) ?? new Map<string, T3dNode>();
    const handMade = input.handMadeUnits.get(asset.path) ?? [];
    const declared = new Set(input.snapshotVariables?.get(asset.path) ?? []);
    const spans = new Map<string, Span>(asset.units.map((u) => [u.id, u.origin]));

    // Own fields: a changed type is refused before any apply; a field gone from the TS stays in the asset (and the manifest).
    const fieldVars = asset.variables.filter((v) => v.temp !== true);
    let retyped = false;
    for (const v of fieldVars) {
      const mv = manifest?.variables.find((m) => m.name === v.name);
      if (mv === undefined || mv.type === v.type) continue;
      retyped = true;
      diagnostics.push({
        severity: "error",
        code: "ABFC2047",
        asset: asset.path,
        span: v.origin,
        message: `changing the type of own field ${v.name} (${mv.type} -> ${v.type}) is not supported yet.`,
        fix: "keep the type, or rename the field (the old variable stays in the asset until you delete it in the Mod Editor).",
      });
    }
    if (retyped) continue;
    // TS wins: an own field gone from the TS is removed from the asset (a record of it that is not in the asset any more is only dropped).
    const removeVariables: string[] = [];
    const forgetVariables: string[] = [];
    for (const mv of manifest?.variables ?? []) {
      if (mv.name.startsWith("abfc_") || fieldVars.some((v) => v.name === mv.name)) continue;
      if (declared.has(mv.name)) removeVariables.push(mv.name);
      else forgetVariables.push(mv.name);
      diagnostics.push({
        severity: "warning",
        code: "ABFC5011",
        asset: asset.path,
        message: `removed own field ${mv.name}: it is no longer declared in TypeScript, so the variable is removed from ${asset.path.slice(asset.path.lastIndexOf("/") + 1)}.`,
      });
    }
    const newFields = fieldVars.filter((v) => !declared.has(v.name));

    /** What this build replaces or removes from the asset beyond its own changes (TS wins): reported once as ABFC5014. */
    const report: string[] = [];
    const picked: Array<{ unit: IrUnit; removeNodes: string[] }> = [];
    /** Names of events that this build adds (no custom event in the stage yet). */
    const newEvents = new Set<string>();
    for (const unit of asset.units) {
      const mu: ManifestUnit | undefined = manifest?.units.find((m) => m.id === unit.id);
      let state = mu ? unitState(mu, snapshot, input.stage) : null;
      // A stage re-synced from a published mod that holds the abfc-built graph: the unit is as clean as before the resync.
      if (mu && state === "staleStage" && builtGraphMatches(mu, snapshot)) state = "clean";

      if (!mu || state === "pendingApply") {
        // TS wins: a hand-made event of the same name is replaced (the nodes only it reaches go with it); nothing is refused.
        let handMadeNodes: string[] = [];
        if (!(mu?.adopt) && (handMade.includes(unit.name) || hasHandMadeEvent(snapshot, unit.name, unit.kind))) {
          try {
            handMadeNodes = analyzeAdoption(snapshot, unit.graph, unit.name, { kind: unit.kind === "override" ? "override" : "event" }).owned;
          } catch {
            // no entry node in the snapshot (the name comes from the `_Manual` interface only): nothing to remove
          }
          report.push(`${unit.id}: replaced the hand-made ${unit.kind === "override" ? "override" : "event"} of the same name${handMadeNodes.length > 0 ? ` (${plural(handMadeNodes.length, "node")})` : ""}`);
        }
        if (unit.kind === "event" && !hasHandMadeEvent(snapshot, unit.name)) newEvents.add(unit.name);
        // a manifest unit that was never applied records no tag, but may still have left some
        picked.push({ unit, removeNodes: [...handMadeNodes, ...(mu ? tagsOf(snapshot, mu.id, mu.graph) : [])] });
        continue;
      }

      // TS wins: an edited, missing-node or changed-adoption unit is replaced, never refused. The report names what was found.
      const drift = driftDiagnostics(asset.path, [mu], snapshot, input.stage, spans, { severity: "warning" });
      if (drift.length > 0) {
        for (const d of drift) report.push(`${d.code}: ${d.message}`);
        picked.push({ unit, removeNodes: [...mu.nodes.filter((n) => snapshot.has(n)), ...(mu.adopt?.nodes ?? []).filter((n) => snapshot.has(n)), ...tagsOf(snapshot, mu.id, mu.graph)] });
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
        const drift = driftDiagnostics(asset.path, [mu], snapshot, input.stage, new Map<string, Span>(), { severity: "warning" });
        if (drift.length > 0) {
          // TS wins: the removed unit goes although it was edited or lost nodes; the nodes still on the stage are removed.
          for (const d of drift) report.push(`${d.code}: ${d.message}`);
          removeUnits.push({ id: mu.id, graph: mu.graph, nodes: [...mu.nodes.filter((n) => snapshot.has(n)), ...tagsOf(snapshot, mu.id, mu.graph)] });
        } else forgetUnits.push(mu.id); // adopted hand-made nodes of a stale stage: nothing of abfc's to remove
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

    // A removed or renamed event that a node staying on the stage still calls. Unreal's compile would refuse that graph with a message
    // that names no TS line and the apply would be rolled back, so refuse before the apply and name the node, its graph and its owner.
    const hybridAsset = input.hybrid?.has(asset.path) === true;
    const leaving = new Set<string>([...removeUnits.flatMap((r) => r.nodes), ...picked.flatMap((p) => p.removeNodes)]);
    for (const r of removeUnits) {
      if (!r.id.startsWith("event:")) continue;
      const name = r.id.slice("event:".length);
      if (asset.units.some((u) => u.name === name)) continue; // declared again as another unit of the same name: the calls still resolve
      for (const n of snapshot.values()) {
        if (leaving.has(n.name) || !n.cls.includes("K2Node_Call") || !callsOwnFunction(n, name)) continue;
        const owner = manifest?.units.find((m) => m.nodes.includes(n.name));
        if (owner === undefined && !hybridAsset) continue; // TS wins: a hand-made node of a non-hybrid class goes with the sweep below
        const where = `${n.name} in graph ${n.graph ?? "?"}`;
        if (owner !== undefined) {
          diagnostics.push({
            severity: "error",
            code: "ABFC5009",
            asset: asset.path,
            ...(spans.get(owner.id) !== undefined ? { span: spans.get(owner.id)! } : {}),
            message: `${name} is no longer declared in TypeScript, but ${where} (unit ${owner.id}) still calls it.`,
            fix: `change the call in the TypeScript of ${owner.id}, or declare ${name} again.`,
          });
        } else {
          diagnostics.push({
            severity: "error",
            code: "ABFC5009",
            asset: asset.path,
            message: `${name} is no longer declared in TypeScript, but the hand-made node ${where} (kept: the class merges with its _Manual interface) still calls it.`,
            fix: `point that node at another function or delete it in the Mod Editor; or declare ${name} again.`,
          });
        }
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

    // TS wins, non-hybrid class: everything in the asset that no TS unit owns is removed (nodes, function graphs, member variables).
    // Kept because no TS form exists: macros, event dispatchers, interface and override functions, disabled engine default events,
    // the entry and result nodes of function graphs, components and the widget tree (they are not nodes or variables of a graph).
    const removeGraphNodes: NonNullable<AssetPlan["removeGraphNodes"]> = [];
    const removeFunctions: string[] = [];
    if (!hybridAsset && snapshot.size > 0) {
      const tsUnitIds = new Set(asset.units.map((u) => u.id));
      const gone = new Set<string>([...leaving, ...removeTags.flatMap((r) => r.nodes)]);
      const owned = new Set<string>();
      for (const mu of manifest?.units ?? []) {
        if (!tsUnitIds.has(mu.id)) continue;
        for (const n of [...mu.nodes, ...(mu.adopt?.nodes ?? [])]) owned.add(n);
      }
      const delegates = new Set<string>();
      for (const [name, type] of input.snapshotVariableTypes?.get(asset.path) ?? []) if (type.startsWith("unsupported:mcdelegate") || type.startsWith("unsupported:delegate")) delegates.add(name);
      const functionGraphs = new Map<string, T3dNode>(); // graph -> its K2Node_FunctionEntry
      const macroGraphs = new Set<string>();
      for (const n of snapshot.values()) {
        if (n.graph === null) continue;
        if (n.cls.endsWith("K2Node_FunctionEntry")) functionGraphs.set(n.graph, n);
        else if (n.cls.endsWith("K2Node_Tunnel")) macroGraphs.add(n.graph);
      }
      const dropGraphs = new Set<string>();
      for (const [graph, entry] of functionGraphs) {
        const tsFunction = asset.units.some((u) => u.graph === graph);
        const inherited = entry.head.some((h) => h.startsWith("FunctionReference=") && h.includes("MemberParent=")); // interface or override function
        if (tsFunction || inherited || delegates.has(graph) || graph === "UserConstructionScript") continue;
        dropGraphs.add(graph);
        removeFunctions.push(graph);
        report.push(`removed the hand-made function ${graph}`);
      }
      const byGraph = new Map<string, string[]>();
      for (const n of snapshot.values()) {
        if (n.graph === null || macroGraphs.has(n.graph) && !functionGraphs.has(n.graph) || dropGraphs.has(n.graph)) continue;
        if (gone.has(n.name) || owned.has(n.name)) continue;
        if (n.cls.endsWith("K2Node_FunctionEntry") || n.cls.endsWith("K2Node_FunctionResult")) continue;
        if (n.cls.endsWith("K2Node_Event") && n.head.includes("EnabledState=Disabled")) continue;
        const tagOf = tagUnitOf(n);
        if (tagOf !== null && tsUnitIds.has(tagOf)) continue;
        (byGraph.get(n.graph) ?? byGraph.set(n.graph, []).get(n.graph)!).push(n.name);
      }
      for (const [graph, nodes] of byGraph) {
        removeGraphNodes.push({ graph, nodes });
        report.push(`removed ${plural(nodes.length, "hand-made node")} from ${graph} (${nodes.slice(0, 5).join(", ")}${nodes.length > 5 ? ", ..." : ""})`);
      }
      const fields = new Set(fieldVars.map((v) => v.name));
      const handMadeVars: string[] = [];
      for (const name of input.snapshotVariables?.get(asset.path) ?? []) {
        if (fields.has(name) || removeVariables.includes(name) || delegates.has(name)) continue;
        if (asset.units.some((u) => name.startsWith(`abfc_${u.name}_`))) continue;
        handMadeVars.push(name);
      }
      if (handMadeVars.length > 0) {
        removeVariables.push(...handMadeVars);
        report.push(`removed the hand-made ${handMadeVars.length === 1 ? "variable" : "variables"} ${handMadeVars.join(", ")}`);
      }
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
    if (asset.classDefaults !== undefined || asset.classManagerRow !== undefined || asset.director !== undefined || (manifest?.directorRow !== undefined && asset.director === undefined)) {
      const values = asset.classDefaults ?? {};
      const hash = classDefaultsHash(values, asset.classManagerRow, asset.director?.asset, asset.director?.tag);
      if (defaultsStale(asset, manifest, input.stage, input.directorRows === true)) {
        const classPath = `${asset.path}.${asset.path.slice(asset.path.lastIndexOf("/") + 1)}_C`;
        defaults = {
          classPath,
          values,
          hash,
          ...(asset.classManagerRow !== undefined ? { classManagerRow: asset.classManagerRow } : {}),
          ...(asset.director !== undefined ? { director: { asset: asset.director.asset, classPath, ...(asset.director.tag !== undefined ? { tag: asset.director.tag } : {}) } } : {}),
        };
      }
    }
    if (report.length > 0) {
      diagnostics.push({
        severity: "warning",
        code: "ABFC5014",
        asset: asset.path,
        message: `${asset.path.slice(asset.path.lastIndexOf("/") + 1)}: TypeScript wins, this build replaces what was changed in the Mod Editor: ${report.join("; ")}.`,
        fix: "to keep a change, move it into the .ts file before building.",
      });
    }
    if (
      create === undefined && picked.length === 0 && newFields.length === 0 && defaults === undefined && removeUnits.length === 0 && forgetUnits.length === 0 &&
      removeTags.length === 0 && removeGraphNodes.length === 0 && removeVariables.length === 0 && removeFunctions.length === 0 && forgetVariables.length === 0
    ) continue;

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
    for (const r of removeGraphNodes) {
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
      (v) => (v.temp === true ? prefixes.some((pre) => v.name.startsWith(pre)) : true) && !declared.has(v.name),
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
      ...(create !== undefined ? { create } : {}),
      graphNodes,
      variables,
      units,
      classMeta: ir.classMeta,
      ...(Object.keys(entryNames).length > 0 ? { entryNames } : {}),
      ...(defaults !== undefined ? { defaults } : {}),
      ...(removeUnits.length > 0 ? { removeUnits } : {}),
      ...(forgetUnits.length > 0 ? { forgetUnits } : {}),
      ...(removeTags.length > 0 ? { removeTags } : {}),
      ...(removeGraphNodes.length > 0 ? { removeGraphNodes } : {}),
      ...(removeVariables.length > 0 ? { removeVariables } : {}),
      ...(removeFunctions.length > 0 ? { removeFunctions } : {}),
      ...(forgetVariables.length > 0 ? { forgetVariables } : {}),
    });
  }

  return { plan: { mod: ir.mod, assets }, diagnostics, upToDate };
}
