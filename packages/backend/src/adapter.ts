// IR -> bp_apply adapter (design 7.3): renders an ApplyPlan into bp_apply specs and runs it against a Backend.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AbfcError } from "@abfc/env";
import { parseBpType } from "@abfc/ir";
import type { ApplyPlan, AssetPlan, BackendCapabilities, Diagnostic, IrNode, IrParam, IrUnit, Profile } from "@abfc/ir";
import { applyTwoPhase } from "./fallback.js";
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
  variables?: Array<{ name: string; type: string; flags: number }>;
  graphs?: BpGraphSpec[];
  raw?: Array<{ kind: "graph"; graph: string; text: string }>;
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
 * Throws ABFC4010 for what the backend refuses (exec, map, set types; any entry on a self or macro node).
 */
export function effectivePinTypes(n: IrNode, caps: BackendCapabilities, profile: Profile): Record<string, string> {
  const entries = Object.entries(n.pinTypes ?? {});
  if (entries.length === 0) return {};
  if (n.sem?.k === "self" || /K2Node_MacroInstance$/.test(n.t3d.class)) throw refused(n, "on a self/macro node");
  const out: Record<string, string> = {};
  for (const [pin, type] of entries) {
    if (/(^|:)exec($|:)/.test(type) || /(^|:)(map|set):/.test(type)) throw refused(n, `"${type}"`);
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

/** Main apply spec of one asset: variables plus, per graph, the nodes to remove, the new nodes and their wires. */
export function renderMainSpec(a: AssetPlan, caps: BackendCapabilities, profile: Profile): BpApplyAssetSpec {
  const spec: BpApplyAssetSpec = { asset: a.asset };
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

/** Applies the plan: one main pass (native pin types, or the two-phase fallback), then the tag pass. */
export async function applyPlan(
  backend: Backend,
  plan: ApplyPlan,
  caps: BackendCapabilities,
  profile: Profile,
  o: ApplyOptions,
): Promise<ApplyOutcome> {
  if (plan.assets.length === 0) return { ok: true, perAsset: [] };
  const specs = plan.assets.map((a) => renderMainSpec(a, caps, profile));
  const refs = plan.assets.map((a, i) => patchRefs(a, specs[i]!, caps, profile));
  const needsFallback = !caps.pinTypes && refs.some((r) => r.length > 0);

  let ok: boolean;
  let last: BpApplyResult;
  let nodeIdMaps: Array<Record<string, Record<string, string>>>;
  let errors: CompileMessage[];
  if (needsFallback) {
    const classMeta = Object.assign({}, ...plan.assets.map((a) => a.classMeta)) as Record<string, string>;
    const fb: FallbackAsset[] = specs.map((spec, i) => ({ spec, patches: refs[i]! }));
    const r = await applyTwoPhase(backend, plan.mod, fb, classMeta, o);
    ({ ok, last, nodeIds: nodeIdMaps, errors } = r);
  } else {
    last = await backend.applySpecs(plan.mod, specs, { label: "main", cacheDir: o.cacheDir });
    o.record("apply.main", last.seconds);
    ok = last.ok;
    nodeIdMaps = plan.assets.map((a, i) => entryFor(last, a.asset, i)?.node_ids ?? {});
    errors = ok ? [] : last.compile.errors.length > 0 ? last.compile.errors : last.error ? [{ asset: null, message: last.error }] : [];
  }

  const perAsset: AssetApplyOutcome[] = plan.assets.map((a, i) => {
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
    };
  });
  if (!ok) return { ok: false, perAsset };

  const tagSpecs = plan.assets.map((a) => renderTagSpec(a, a.units, profile));
  const tag = await backend.applySpecs(plan.mod, tagSpecs, { label: "tags", cacheDir: o.cacheDir });
  o.record("apply.tags", tag.seconds);
  plan.assets.forEach((a, i) => {
    const out = perAsset[i]!;
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
    const entry = entryFor(tag, a.asset, i);
    const graphs = tagSpecs[i]!.graphs ?? [];
    for (const u of a.units) {
      const k = graphs.findIndex((g) => g.graph === u.unit.graph);
      const real = entry?.node_ids[`graph:${k}`]?.[`cmt_${slug(u.unit.name)}`];
      if (real !== undefined) out.tagNames[u.unit.id] = real;
    }
    out.tagName = Object.values(out.tagNames)[0] ?? null;
    out.finalText = readFinal(tag.run, i) ?? out.finalText;
  });
  return { ok: true, perAsset };
}
