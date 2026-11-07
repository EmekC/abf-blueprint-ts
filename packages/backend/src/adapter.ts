// IR -> bp_apply adapter (design 7.3): renders an ApplyPlan into bp_apply specs and runs it against a Backend.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AbfcError } from "@abfc/env";
import { parseBpType } from "@abfc/ir";
import type { ApplyPlan, AssetPlan, BackendCapabilities, Diagnostic, EventMeta, IrNode, IrParam, IrUnit, Profile } from "@abfc/ir";
import { renderDefaultsCode } from "./defaults-template.js";
import { applyErrors, applyTwoPhase } from "./fallback.js";
import type { FallbackAsset, WildcardPatchRef } from "./fallback.js";
import type { Backend, BpApplyResult, CompileMessage } from "./types.js";

export interface BpNodeSpec {
  id: string;
  k: string;
  name?: string;
  class?: string;
  function?: string;
  target?: string;
  params?: IrParam[];
  meta?: EventMeta;
  props?: string[];
  pos: [number, number];
  set?: Record<string, string>;
  objects?: Record<string, string>;
  pin_types?: Record<string, string>;
}

export interface BpGraphSpec {
  graph: string;
  remove?: string[];
  add: BpNodeSpec[];
  wires?: Array<[string, string]>;
}

export interface BpApplyAssetSpec {
  asset: string;
  create?: { class: "Blueprint" | "WidgetBlueprint"; parent: string; if_missing: true } | { class: "UserDefinedStruct"; if_missing: true };
  /** Fields of a UserDefinedStruct (valid only with `create.class` UserDefinedStruct): `name` is `<friendly>_<index>_<guid>`. */
  struct_fields?: Array<{ name: string; friendly: string; guid: string; type: string }>;
  variables?: Array<{ name: string; type: string; flags: number }>;
  graphs?: BpGraphSpec[];
  raw?: Array<{ kind: "graph"; graph: string; text: string } | { kind: "python"; code: string }>;
}

function refused(n: IrNode, what: string): AbfcError {
  return new AbfcError({
    severity: "error",
    code: "ABFC4010",
    message: `node ${n.id} (${n.t3d.class}): pin type ${what} is refused by the backend; abfc never emits it (internal error).`,
    span: n.origin,
  }, 2);
}

/**
 * The pin types to send for a node: the IR `pinTypes` minus the cast `Object` pin when the backend types it itself.
 * Throws ABFC4010 for what the backend refuses (exec; map/set types without the matching container capability; any entry on a self or macro node).
 */
export function effectivePinTypes(n: IrNode, caps: BackendCapabilities, profile: Profile): Record<string, string> {
  const entries = Object.entries(n.pinTypes ?? {});
  if (entries.length === 0) return {};
  if (n.sem?.k === "self" || /K2Node_MacroInstance$/.test(n.t3d.class)) throw refused(n, "on a self/macro node");
  const out: Record<string, string> = {};
  for (const [pin, type] of entries) {
    if (
      /(^|:)exec($|:)/.test(type) ||
      (!caps.containerTypes.map && /(^|:)map:/.test(type)) ||
      (!caps.containerTypes.set && /(^|:)set:/.test(type))
    ) throw refused(n, `"${type}"`);
    parseBpType(type);
    if (n.sem?.k === "cast" && caps.castObjectPin && pin === profile.pins.castObject) continue;
    out[pin] = type;
  }
  return out;
}

const slug = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "_");

/** Node id in the spec: unique within a graph even when several units share it. */
export function specNodeId(unit: IrUnit, nodeId: string): string {
  return `${slug(unit.name)}_${nodeId}`;
}

/** Key of a node in the result maps: `<unit id>/<IR node id>`. */
export function nodeKey(unit: IrUnit, nodeId: string): string {
  return `${unit.id}/${nodeId}`;
}

function toBpNode(unit: IrUnit, n: IrNode, origin: [number, number], caps: BackendCapabilities, profile: Profile): BpNodeSpec {
  const out: BpNodeSpec = { id: specNodeId(unit, n.id), k: "node", pos: [origin[0] + n.pos[0], origin[1] + n.pos[1]] };
  const s = n.sem;
  if (s) {
    out.k = s.k;
    switch (s.k) {
      case "call":
        if (s.class !== undefined) out.class = s.class;
        out.function = s.function;
        break;
      case "get":
      case "set":
        out.name = s.name;
        if (s.class !== undefined) out.class = s.class;
        break;
      case "event":
        out.name = s.name;
        if (s.params && s.params.length > 0) out.params = s.params;
        if (s.meta && caps.eventMeta) out.meta = { ...s.meta };
        break;
      case "override":
        out.class = s.class;
        out.function = s.function;
        break;
      case "cast":
        out.target = s.target;
        break;
      case "call_dispatcher":
      case "bind_dispatcher":
        out.name = s.name;
        break;
      default:
        break;
    }
  } else {
    out.class = n.t3d.class;
    out.props = n.t3d.props;
  }
  if (n.pinDefaults && Object.keys(n.pinDefaults).length > 0) out.set = { ...n.pinDefaults };
  if (n.pinObjects && Object.keys(n.pinObjects).length > 0) out.objects = { ...n.pinObjects };
  if (caps.pinTypes) {
    const pt = effectivePinTypes(n, caps, profile);
    if (Object.keys(pt).length > 0) out.pin_types = pt;
  }
  return out;
}

/** `<Field>_<index>_<GUID>` -> the backend's struct_fields entry (friendly name = the field, guid = the 32 hex digits). */
function structFieldSpec(name: string, type: string): { name: string; friendly: string; guid: string; type: string } {
  const m = /^(.+)_\d+_([0-9A-F]{32})$/.exec(name);
  if (m === null) throw new AbfcError({ severity: "error", code: "ABFC4010", message: `struct member name ${name} is not <Field>_<index>_<GUID>.` }, 2);
  return { name, friendly: m[1]!, guid: m[2]!, type };
}

/** Main apply spec of one asset: variables plus, per graph, the nodes to remove, the new nodes and their wires. */
export function renderMainSpec(a: AssetPlan, caps: BackendCapabilities, profile: Profile): BpApplyAssetSpec {
  const spec: BpApplyAssetSpec = { asset: a.asset };
  if (a.struct !== undefined) {
    spec.create = { class: "UserDefinedStruct", if_missing: true };
    spec.struct_fields = a.struct.fields.map((f) => structFieldSpec(f.name, f.type));
    return spec;
  }
  // A missing asset is created by the first spec that names it; `if_missing` keeps a repeated apply (the fallback route runs two) idempotent.
  if (a.create !== undefined) spec.create = { class: a.create.class, parent: a.create.parent, if_missing: true };
  if (a.variables.length > 0) {
    spec.variables = a.variables.map((v) => ({
      name: v.name,
      type: v.type,
      flags: profile.variableFlags.base | (v.flags.includes("transient") ? profile.variableFlags.transient : 0),
    }));
  }
  const graphs = new Map<string, BpGraphSpec>();
  for (const u of a.units) {
    const g = graphs.get(u.unit.graph) ?? { graph: u.unit.graph, remove: [], add: [], wires: [] };
    graphs.set(u.unit.graph, g);
    for (const r of u.removeNodes) if (!g.remove!.includes(r)) g.remove!.push(r);
    for (const n of u.unit.nodes) g.add.push(toBpNode(u.unit, n, u.origin, caps, profile));
    for (const [from, to] of u.unit.wires) {
      const conv = (end: string): string => {
        const dot = end.indexOf(".");
        return `${specNodeId(u.unit, end.slice(0, dot))}${end.slice(dot)}`;
      };
      g.wires!.push([conv(from), conv(to)]);
    }
    for (const w of u.unit.crossWires ?? []) {
      // The target entry is a spec id when its unit is in this plan, else the real node name recorded in the manifest.
      const target = a.units.find((x) => x.unit.id === w.toUnit);
      const real = a.entryNames?.[w.toUnit];
      const dotFrom = w.from.indexOf(".");
      const dotTo = w.to.indexOf(".");
      const entry = target ? specNodeId(target.unit, w.from.slice(0, dotFrom)) : real;
      if (entry === undefined) {
        throw new AbfcError({
          severity: "error",
          code: "ABFC4012",
          message: `${u.unit.id}: the event ${w.toUnit} that supplies its delegate is neither in this build nor recorded in the manifest.`,
          span: u.unit.origin,
        }, 2);
      }
      g.wires!.push([`${entry}${w.from.slice(dotFrom)}`, `${specNodeId(u.unit, w.to.slice(0, dotTo))}${w.to.slice(dotTo)}`]);
    }
  }
  // Units that are no longer in the TS: their nodes (and tag comment) go away with the same apply.
  for (const r of a.removeUnits ?? []) {
    const g = graphs.get(r.graph) ?? { graph: r.graph, remove: [], add: [], wires: [] };
    graphs.set(r.graph, g);
    for (const name of r.nodes) if (!g.remove!.includes(name)) g.remove!.push(name);
  }
  // Orphan tag comments of units that stay: removed with the same apply.
  for (const r of a.removeTags ?? []) {
    const g = graphs.get(r.graph) ?? { graph: r.graph, remove: [], add: [], wires: [] };
    graphs.set(r.graph, g);
    for (const name of r.nodes) if (!g.remove!.includes(name)) g.remove!.push(name);
  }
  spec.graphs = [...graphs.values()];
  return spec;
}

/** Spec that adds one ownership comment box per unit (design 8.2). */
export function renderTagSpec(a: AssetPlan, units: AssetPlan["units"], profile: Profile): BpApplyAssetSpec {
  const byGraph = new Map<string, BpNodeSpec[]>();
  for (const u of units) {
    const w = Math.max(0, ...u.unit.nodes.map((n) => n.pos[0])) + 400;
    const h = Math.max(0, ...u.unit.nodes.map((n) => n.pos[1])) + 300;
    const ir = u.unit.hash.replace(/^sha256:/, "").slice(0, 8);
    const list = byGraph.get(u.unit.graph) ?? [];
    byGraph.set(u.unit.graph, list);
    list.push({
      id: `cmt_${slug(u.unit.name)}`,
      k: "node",
      class: profile.nodeClasses.comment,
      props: [
        `NodeComment="abfc:owned unit=${u.unit.id} src=${u.unit.origin.file} ir=${ir} - generated by abfc, edit the .ts file"`,
        `NodeWidth=${w}`,
        `NodeHeight=${h}`,
      ],
      pos: [u.origin[0] - 50, u.origin[1] - 120],
    });
  }
  return { asset: a.asset, graphs: [...byGraph.entries()].map(([graph, add]) => ({ graph, add })) };
}

export interface ApplyOptions {
  cacheDir: string;
  record(step: string, seconds: number): void;
}

export interface AssetApplyOutcome {
  asset: string;
  /** `<unit id>/<IR node id>` -> real node name. */
  nodeIds: Record<string, string>;
  finalText: string | null;
  compile: CompileMessage[];
  /** Real name of the first unit's comment box. */
  tagName: string | null;
  /** Unit id -> real name of its comment box. */
  tagNames: Record<string, string>;
  tagWarning?: Diagnostic;
  /** The class-defaults pass (pass 5) ran for this asset and succeeded; false when it was not planned or failed. */
  defaultsApplied: boolean;
  /** Warnings of pass 5: ABFC2070 (class manager row), ABFC5102 (the pass failed; it is repeated by the next build). */
  defaultsWarnings: Diagnostic[];
}

export interface ApplyOutcome {
  ok: boolean;
  perAsset: AssetApplyOutcome[];
}

function entryFor(r: BpApplyResult, asset: string, i: number): NonNullable<BpApplyResult["assets"]>[number] | undefined {
  return r.assets?.find((x) => x.asset === asset) ?? r.assets?.[i];
}

function readFinal(run: string, i: number): string | null {
  if (run === "") return null;
  const file = join(run, `final_${i}.t3d`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function patchRefs(a: AssetPlan, spec: BpApplyAssetSpec, caps: BackendCapabilities, profile: Profile): WildcardPatchRef[] {
  const refs: WildcardPatchRef[] = [];
  for (const u of a.units) {
    const graphIndex = (spec.graphs ?? []).findIndex((g) => g.graph === u.unit.graph);
    for (const n of u.unit.nodes) {
      for (const [pin, type] of Object.entries(effectivePinTypes(n, caps, profile))) {
        refs.push({ graphIndex, specNode: specNodeId(u.unit, n.id), pin, type });
      }
    }
  }
  return refs;
}

/** Spec of the class-defaults pass of one asset: one fixed Python template (see defaults-template.ts). */
export function renderDefaultsSpec(a: AssetPlan): BpApplyAssetSpec {
  const d = a.defaults!;
  return { asset: a.asset, raw: [{ kind: "python", code: renderDefaultsCode(d.classPath, d.values, d.classManagerRow) }] };
}

/** Pass 5: class defaults of every asset whose plan has a `defaults` item. A failure is a warning (the next build repeats it). */
async function applyDefaultsPass(backend: Backend, plan: ApplyPlan, perAsset: AssetApplyOutcome[], o: ApplyOptions): Promise<void> {
  const targets = plan.assets.map((a, i) => ({ a, i })).filter((x) => x.a.defaults !== undefined);
  if (targets.length === 0) return;
  const specs = targets.map((x) => renderDefaultsSpec(x.a));
  const r = await backend.applySpecs(plan.mod, specs, { label: "defaults", cacheDir: o.cacheDir });
  o.record("apply.defaults", r.seconds);
  for (const { a, i } of targets) {
    const out = perAsset[i]!;
    if (!r.ok) {
      out.defaultsWarnings.push({
        severity: "warning",
        code: "ABFC5102",
        asset: a.asset,
        message: `the class-defaults pass failed for ${a.asset}: ${r.error ?? r.compile.errors[0]?.message ?? "unknown error"}. The class defaults are not applied.`,
        fix: "run abfc build again; the pass is repeated.",
      });
      continue;
    }
    out.defaultsApplied = true;
    const text = [r.logTail ?? "", ...r.compile.warnings.map((w) => w.message)].join("\n");
    for (const line of text.split(/\r?\n/)) {
      const at = line.indexOf("ABFC2070");
      if (at >= 0) out.defaultsWarnings.push({ severity: "warning", code: "ABFC2070", asset: a.asset, message: line.slice(at + "ABFC2070".length).trim() });
    }
  }
}

/** Applies the plan: one main pass (native pin types, or the two-phase fallback), then the tag pass, then the class-defaults pass (pass 5). */
export async function applyPlan(
  backend: Backend,
  plan: ApplyPlan,
  caps: BackendCapabilities,
  profile: Profile,
  o: ApplyOptions,
): Promise<ApplyOutcome> {
  if (plan.assets.length === 0) return { ok: true, perAsset: [] };
  // Assets that only carry class defaults have no graph work: they take part in pass 5 only (new own fields still go through the main spec).
  const unitAssets = plan.assets.filter((a) => a.create !== undefined || a.struct !== undefined || a.units.length > 0 || a.variables.length > 0 || (a.removeUnits?.length ?? 0) > 0 || (a.removeTags?.length ?? 0) > 0);
  if (unitAssets.length === 0) {
    const only: AssetApplyOutcome[] = plan.assets.map((a) => ({ asset: a.asset, nodeIds: {}, finalText: null, compile: [], tagName: null, tagNames: {}, defaultsApplied: false, defaultsWarnings: [] }));
    await applyDefaultsPass(backend, plan, only, o);
    return { ok: true, perAsset: only };
  }
  const specs =unitAssets.map((a) => renderMainSpec(a, caps, profile));
  const refs = unitAssets.map((a, i) => patchRefs(a, specs[i]!, caps, profile));
  const needsFallback = !caps.pinTypes && refs.some((r) => r.length > 0);

  let ok: boolean;
  let last: BpApplyResult;
  let nodeIdMaps: Array<Record<string, Record<string, string>>>;
  let errors: CompileMessage[];
  if (needsFallback) {
    const classMeta = Object.assign({}, ...unitAssets.map((a) => a.classMeta)) as Record<string, string>;
    const fb: FallbackAsset[] = specs.map((spec, i) => ({ spec, patches: refs[i]! }));
    const r = await applyTwoPhase(backend, plan.mod, fb, classMeta, o);
    ({ ok, last, nodeIds: nodeIdMaps, errors } = r);
  } else {
    last = await backend.applySpecs(plan.mod, specs, { label: "main", cacheDir: o.cacheDir });
    o.record("apply.main", last.seconds);
    ok = last.ok;
    nodeIdMaps = unitAssets.map((a, i) => entryFor(last, a.asset, i)?.node_ids ?? {});
    errors = ok ? [] : applyErrors(last);
  }

  const perUnitAsset: AssetApplyOutcome[] = unitAssets.map((a, i) => {
    const specIds = nodeIdMaps[i] ?? {};
    const nodeIds: Record<string, string> = {};
    for (const u of a.units) {
      const k = (specs[i]!.graphs ?? []).findIndex((g) => g.graph === u.unit.graph);
      const ids = specIds[`graph:${k}`] ?? {};
      for (const n of u.unit.nodes) {
        const real = ids[specNodeId(u.unit, n.id)];
        if (real !== undefined) nodeIds[nodeKey(u.unit, n.id)] = real;
      }
    }
    return {
      asset: a.asset,
      nodeIds,
      finalText: ok ? readFinal(last.run, i) : null,
      compile: errors.filter((e) => e.asset === null || e.asset === a.asset),
      tagName: null,
      tagNames: {},
      defaultsApplied: false,
      defaultsWarnings: [],
    };
  });
  const perAsset: AssetApplyOutcome[] = plan.assets.map(
    (a) => perUnitAsset[unitAssets.indexOf(a)] ?? { asset: a.asset, nodeIds: {}, finalText: null, compile: [], tagName: null, tagNames: {}, defaultsApplied: false, defaultsWarnings: [] },
  );
  if (!ok) return { ok: false, perAsset };

  // Only assets with units get a comment box (an asset with only removals has nothing to tag).
  const tagAssets = unitAssets.map((a, i) => ({ a, i })).filter((x) => x.a.units.length > 0);
  if (tagAssets.length > 0) {
    const tagSpecs = tagAssets.map((x) => renderTagSpec(x.a, x.a.units, profile));
    const tag = await backend.applySpecs(plan.mod, tagSpecs, { label: "tags", cacheDir: o.cacheDir });
    o.record("apply.tags", tag.seconds);
    tagAssets.forEach(({ a, i: mainIndex }, ti) => {
      const out = perUnitAsset[mainIndex]!;
      if (!tag.ok) {
        out.tagWarning = {
          severity: "warning",
          code: "ABFC5101",
          asset: a.asset,
          message: `the ownership tag pass failed for ${a.asset}: ${tag.error ?? tag.compile.errors[0]?.message ?? "unknown error"}. The units are applied but carry no comment box.`,
          fix: "run abfc build again; the tag pass is repeated.",
        };
        return;
      }
      const entry = entryFor(tag, a.asset, ti);
      const graphs = tagSpecs[ti]!.graphs ?? [];
      for (const u of a.units) {
        const k = graphs.findIndex((g) => g.graph === u.unit.graph);
        const real = entry?.node_ids[`graph:${k}`]?.[`cmt_${slug(u.unit.name)}`];
        if (real !== undefined) out.tagNames[u.unit.id] = real;
      }
      out.tagName = Object.values(out.tagNames)[0] ?? null;
      out.finalText = readFinal(tag.run, ti) ?? out.finalText;
    });
  }
  await applyDefaultsPass(backend, plan, perAsset, o);
  return { ok: true, perAsset };
}
