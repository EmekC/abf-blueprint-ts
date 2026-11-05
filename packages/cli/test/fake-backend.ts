// A fake `Backend` for the CLI end-to-end tests: an in-memory stage of Blueprint assets that renders real-looking T3D
// exports, so that the planner, the drift check, the fallback route and the manifests run on genuine data.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesFrom } from "@abfc/backend";
import type {
  AssetSnapshot,
  AuditReport,
  Backend,
  BpApplyResult,
  CompileMessage,
  CompileReport,
  GameTestReport,
  RawBackendInfo,
  ReflectResult,
  StageReport,
  StageStatus,
} from "@abfc/backend";
import { loadProfile } from "@abfc/env";
import { parseBpType, parseExport, pinObjectText, sha256 } from "@abfc/ir";
import type { BackendInfo, T3dNode } from "@abfc/ir";
import { ALL_TOOLS, fixInfo } from "./helpers.js";

const profile = loadProfile();
const CLS = profile.nodeClasses;

/** The only asset of the fake mod. */
export const RELAY_ASSET = "/TestMod/Relay/BP_Relay";

const EXT_FEATURES = ["reflect", "compile_node_refs", "bp_read_seconds"];
const EXEC_PINS = new Set(["execute", "then", "else", "CastFailed", "NotValid", "Valid", "Completed", "LoopBody"]);

interface FPin {
  id: string;
  name: string;
  dir: "in" | "out";
  category: string;
  sub: string;
  /** Inner path of `PinSubCategoryObject`. */
  obj: string | null;
  container: string;
  def: string | null;
  defObj: string | null;
  links: Array<{ node: string; pinId: string }>;
}

interface FNode {
  name: string;
  cls: string;
  graph: string;
  /** Non-pin lines of the node body (position, references, comment text). */
  head: string[];
  pins: FPin[];
}

interface FAsset {
  path: string;
  variables: Array<{ name: string; type: string }>;
  nodes: FNode[];
}

interface SpecNode {
  id: string;
  k: string;
  name?: string;
  class?: string;
  function?: string;
  target?: string;
  props?: string[];
  pos: [number, number];
  set?: Record<string, string>;
  objects?: Record<string, string>;
  pin_types?: Record<string, string>;
}
interface SpecGraph {
  graph: string;
  remove?: string[];
  add: SpecNode[];
  wires?: Array<[string, string]>;
}
interface Spec {
  asset: string;
  variables?: Array<{ name: string; type: string; flags: number }>;
  graphs?: SpecGraph[];
  raw?: Array<{ kind: "graph"; graph: string; text: string }>;
}

export interface RecordedCall {
  /** MCP tool name: `backend_info`, `staging_sync`, `staging_status`, `bp_read`, `bp_apply`, `bp_compile_report`, `bp_game_test`, `mod_audit`. */
  tool: string;
  /** `bp_apply` label (`main`, `main-a`, `main-b`, `tags`). */
  label?: string;
  specs?: Array<Record<string, any>>;
}

export interface FakeBackendOptions {
  /** The backend lists `backend_info` in the shape of the wildcard-pins branch (default false: an older backend without it). */
  backendInfo?: boolean;
  /** The initial asset holds a hand-made `UpdateTarget` event (default true). */
  handMadeEvent?: boolean;
}

const shortOf = (cls: string): string => cls.slice(cls.lastIndexOf(".") + 1);
const pinId = (node: string, name: string, dir: string): string => sha256(`${node}|${name}|${dir}`).slice(0, 32).toUpperCase();

function getPin(n: FNode, name: string, dir: "in" | "out"): FPin {
  let p = n.pins.find((x) => x.name === name && x.dir === dir);
  if (p === undefined) {
    p = {
      id: pinId(n.name, name, dir),
      name,
      dir,
      category: EXEC_PINS.has(name) ? "exec" : "misc",
      sub: "",
      obj: null,
      container: "None",
      def: null,
      defObj: null,
      links: [],
    };
    n.pins.push(p);
  }
  return p;
}

function typePin(p: FPin, type: string): void {
  const t = parseBpType(type);
  p.category = t.cat;
  p.sub = t.sub;
  p.obj = t.path;
  p.container = t.container;
}

function wildcardPin(p: FPin, container: string): void {
  p.category = "wildcard";
  p.sub = "";
  p.obj = null;
  p.container = container;
}

/** The pins that stay wildcards until a type is given (design 7.3: casts, array functions, array item). */
function wildcardPins(cls: string): Array<{ name: string; dir: "in" | "out"; container: string }> {
  if (cls === CLS.dynamicCast) return [{ name: "Object", dir: "in", container: "None" }];
  if (cls === CLS.callArrayFunction) return [{ name: "TargetArray", dir: "in", container: "Array" }];
  if (cls === CLS.getArrayItem) {
    return [
      { name: "Array", dir: "in", container: "Array" },
      { name: "Output", dir: "out", container: "None" },
    ];
  }
  return [];
}

const objectKind = (category: string): string => (category === "struct" ? "struct" : category === "byte" ? "enum" : "object");

function renderPin(p: FPin): string {
  const obj = p.obj === null ? "None" : `"${pinObjectText(objectKind(p.category), p.obj, {})}"`;
  const parts = [`PinId=${p.id}`, `PinName="${p.name}"`];
  if (p.dir === "out") parts.push('Direction="EGPD_Output"');
  parts.push(
    `PinType.PinCategory="${p.category}"`,
    `PinType.PinSubCategory="${p.sub}"`,
    `PinType.PinSubCategoryObject=${obj}`,
    "PinType.PinSubCategoryMemberReference=()",
    "PinType.PinValueType=()",
    `PinType.ContainerType=${p.container}`,
    "PinType.bIsReference=False",
  );
  if (p.links.length > 0) parts.push(`LinkedTo=(${p.links.map((l) => `${l.node} ${l.pinId}`).join(",")},)`);
  if (p.def !== null) parts.push(`DefaultValue="${p.def}"`);
  if (p.defObj !== null) parts.push(`DefaultObject="${p.defObj}"`);
  parts.push("PersistentGuid=00000000000000000000000000000000", "bHidden=False");
  return `CustomProperties Pin (${parts.join(",")},)`;
}

function renderVarType(type: string): string {
  const t = parseBpType(type);
  const obj = t.path === null ? "None" : `"${pinObjectText(objectKind(t.cat), t.path, {})}"`;
  return `PinCategory="${t.cat}",PinSubCategory="${t.sub}",PinSubCategoryObject=${obj},ContainerType=${t.container}`;
}

/** The editor export (copy format) of an asset, laid out like the real one: class stubs block, then the body block per graph. */
function renderAsset(a: FAsset): string {
  const name = a.path.slice(a.path.lastIndexOf("/") + 1);
  const bp = `${a.path}.${name}`;
  const graphs = [...new Set(["EventGraph", ...a.nodes.map((n) => n.graph)])];
  const out = [`Begin Object Class=/Script/Engine.Blueprint Name="${name}" ExportPath="/Script/Engine.Blueprint'${bp}'"`];
  a.variables.forEach((v, i) => {
    out.push(`   NewVariables(${i})=(VarName="${v.name}",VarType=(${renderVarType(v.type)}),PropertyFlags=0)`);
  });
  for (const g of graphs) {
    const nodes = a.nodes.filter((n) => n.graph === g);
    out.push(`   Begin Object Class=/Script/Engine.EdGraph Name="${g}" ExportPath="/Script/Engine.EdGraph'${bp}:${g}'"`);
    for (const n of nodes) {
      out.push(`      Begin Object Class=${n.cls} Name="${n.name}" ExportPath="${n.cls}'${bp}:${g}.${n.name}'"`);
      out.push("      End Object");
    }
    out.push("   End Object");
    out.push(`   Begin Object Name="${g}" ExportPath="/Script/Engine.EdGraph'${bp}:${g}'"`);
    for (const n of nodes) {
      out.push(`      Begin Object Name="${n.name}" ExportPath="${n.cls}'${bp}:${g}.${n.name}'"`);
      for (const h of n.head) out.push(`         ${h}`);
      for (const p of n.pins) out.push(`         ${renderPin(p)}`);
      out.push("      End Object");
    }
    out.push("   End Object");
  }
  out.push("End Object", "");
  return out.join("\n");
}

function fromT3d(n: T3dNode, graph: string): FNode {
  return {
    name: n.name,
    cls: n.cls,
    graph,
    head: [...n.head],
    pins: n.pins.map((p) => ({
      id: p.id,
      name: p.name,
      dir: p.dir,
      category: p.category,
      sub: p.subCategory,
      obj: p.subCategoryObject,
      container: p.container,
      def: p.defaultValue,
      defObj: p.defaultObject,
      links: p.links.map((l) => ({ node: l.node, pinId: l.pinId })),
    })),
  };
}

function handMade(name: string, cls: string, head: string[], x: number, y: number): FNode {
  return { name, cls, graph: "EventGraph", head: [`NodePosX=${x}`, `NodePosY=${y}`, ...head], pins: [] };
}

function connect(from: FNode, fromPin: string, to: FNode, toPin: string): void {
  const a = getPin(from, fromPin, "out");
  const b = getPin(to, toPin, "in");
  a.links.push({ node: to.name, pinId: b.id });
  b.links.push({ node: from.name, pinId: a.id });
}

/** The asset as it is in the real mod: two hand-made events, each calling HideAll. */
function initialAsset(withUpdateTarget: boolean): FAsset {
  const nodes: FNode[] = [];
  const events: Array<[string, string, number]> = [["K2Node_CustomEvent_1", "OtherEvent", 400]];
  if (withUpdateTarget) events.unshift(["K2Node_CustomEvent_0", "UpdateTarget", 0]);
  for (const [evName, fn, y] of events) {
    const idx = evName.slice(evName.lastIndexOf("_") + 1);
    const ev = handMade(evName, CLS.customEvent, [`CustomFunctionName="${fn}"`], 0, y);
    const call = handMade(`K2Node_CallFunction_${idx}`, CLS.callFunction, ['FunctionReference=(MemberName="HideAll")'], 300, y);
    getPin(ev, "then", "out");
    getPin(call, "execute", "in");
    getPin(call, "then", "out");
    connect(ev, "then", call, "execute");
    nodes.push(ev, call);
  }
  return { path: RELAY_ASSET, variables: [], nodes };
}

export class FakeBackend implements Backend {
  readonly calls: RecordedCall[] = [];
  /** Folder of the run folders (`export.t3d`, `final_<i>.t3d`); real files, below the system temp folder. */
  readonly root: string;
  closed = 0;
  /** Makes the apply that creates `<unit>_<irId>` fail with this message (the failing node is named in the compile error). */
  compileError: { irId: string; unit?: string; message: string } | null = null;
  /** Messages of `bp_compile_report`; any error makes the report unclean. */
  reportMessages: CompileReport["messages"] = [];
  /** Per `bp_game_test` call (in order, counted from `gameTestCalls`): the step indexes that fail. */
  gameTestFailures: number[][] = [];
  gameTestCalls = 0;
  auditOk = true;

  private readonly infoValue: BackendInfo;
  private readonly withUpdateTarget: boolean;
  private assets = new Map<string, FAsset>();
  private staged = false;
  private syncs = 0;
  private counter = 9000;
  private runs = 0;
  private changed = new Set<string>();

  constructor(o: FakeBackendOptions = {}) {
    const withInfo = o.backendInfo === true;
    this.withUpdateTarget = o.handMadeEvent !== false;
    this.root = mkdtempSync(join(tmpdir(), "abfc-fake-backend-"));
    const tools = withInfo ? ALL_TOOLS : ALL_TOOLS.filter((t) => t !== "backend_info");
    const capabilities = capabilitiesFrom(tools, withInfo ? (fixInfo() as RawBackendInfo) : null, { features: EXT_FEATURES });
    this.infoValue = {
      id: "bp_apply",
      serverVersion: "fake-1",
      protocol: withInfo ? 1 : null,
      engineVersion: null,
      editorRoot: null,
      headlessDir: withInfo ? "C:\\abfc-headless" : null,
      documentsDir: withInfo ? "C:\\Users\\Jane\\Documents" : null,
      headlessDirHasSpace: false,
      extensions: EXT_FEATURES,
      capabilities,
    };
  }

  /** The recorded `bp_apply` labels, in order. */
  applyLabels(): string[] {
    return this.calls.filter((c) => c.tool === "bp_apply").map((c) => c.label ?? "");
  }

  tools(): string[] {
    return this.calls.map((c) => c.tool);
  }

  /** Edits a pin default of a node in the stage, as a user would in the editor. */
  setPinDefault(asset: string, node: string, pin: string, value: string): void {
    const n = this.assets.get(asset)?.nodes.find((x) => x.name === node);
    const p = n?.pins.find((x) => x.name === pin);
    if (p === undefined) throw new Error(`fake stage: no pin ${node}.${pin} in ${asset}`);
    p.def = value;
  }

  /** Real names of the nodes of an asset, in the stage. */
  nodeNames(asset: string): string[] {
    return (this.assets.get(asset)?.nodes ?? []).map((n) => n.name);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  async info(): Promise<BackendInfo> {
    if (this.infoValue.protocol !== null) this.calls.push({ tool: "backend_info" });
    return this.infoValue;
  }

  async stage(_modDir: string, o: { discardChanges: boolean }): Promise<StageReport> {
    this.calls.push({ tool: "staging_sync" });
    if (!this.staged || o.discardChanges) {
      this.assets = new Map([[RELAY_ASSET, initialAsset(this.withUpdateTarget)]]);
      this.changed.clear();
    }
    this.staged = true;
    this.syncs++;
    return { mod: "TestMod", files: this.assets.size, stagingPath: join(this.root, "stage") };
  }

  async stageStatus(mod: string): Promise<StageStatus | null> {
    this.calls.push({ tool: "staging_status" });
    if (!this.staged) return null;
    return {
      mod,
      stagingPath: join(this.root, "stage"),
      syncedAt: `sync-${this.syncs}`,
      changed: [...this.changed],
      added: ["Content/_McpTmp/Scratch.uasset"],
      removed: [],
      conflicts: [],
    };
  }

  async read(_mod: string, asset: string): Promise<AssetSnapshot> {
    this.calls.push({ tool: "bp_read" });
    const a = this.assets.get(asset);
    if (a === undefined) throw new Error(`fake stage: no asset ${asset}`);
    const run = this.newRun();
    writeFileSync(join(run, "export.t3d"), renderAsset(a), "utf8");
    return { asset, run, exportPath: join(run, "export.t3d"), structure: null, seconds: 0.2 };
  }

  async applySpecs(_mod: string, specs: unknown[], o: { label: string; cacheDir: string; keepOnError?: boolean }): Promise<BpApplyResult> {
    this.calls.push({ tool: "bp_apply", label: o.label, specs: specs as Array<Record<string, any>> });
    const run = this.newRun();
    const work = new Map([...this.assets].map(([k, v]) => [k, structuredClone(v)]));
    const scripted: CompileMessage[] = [];
    const undetermined: CompileMessage[] = [];
    const assets: NonNullable<BpApplyResult["assets"]> = [];
    const castTyped = this.infoValue.capabilities.castObjectPin;

    (specs as Spec[]).forEach((spec, i) => {
      const a = work.get(spec.asset);
      if (a === undefined) {
        scripted.push({ asset: spec.asset, message: `asset ${spec.asset} does not exist in the stage` });
        assets.push({ asset: spec.asset, node_ids: {} });
        return;
      }
      for (const v of spec.variables ?? []) {
        if (!a.variables.some((x) => x.name === v.name)) a.variables.push({ name: v.name, type: v.type });
      }
      const nodeIds: Record<string, Record<string, string>> = {};
      (spec.graphs ?? []).forEach((g, k) => {
        nodeIds[`graph:${k}`] = this.applyGraph(a, g, castTyped, scripted);
      });
      for (const r of spec.raw ?? []) {
        const wrapped = [
          'Begin Object Class=/Script/Engine.Blueprint Name="Raw"',
          `   Begin Object Name="${r.graph}"`,
          r.text,
          "   End Object",
          "End Object",
        ].join("\n");
        a.nodes = a.nodes.filter((n) => n.graph !== r.graph);
        for (const n of parseExport(wrapped).nodes.values()) a.nodes.push(fromT3d(n, r.graph));
      }
      for (const n of a.nodes) {
        for (const p of n.pins) {
          if (p.category === "wildcard") {
            undetermined.push({
              asset: spec.asset,
              message: `The type of ${p.name} is undetermined. Connect something to determine the type.`,
            });
          }
        }
      }
      assets.push({ asset: spec.asset, node_ids: nodeIds });
      writeFileSync(join(run, `final_${i}.t3d`), renderAsset(a), "utf8");
    });

    const errors = [...undetermined, ...scripted];
    const ok = errors.length === 0;
    if (ok) {
      this.assets = work;
      for (const a of (specs as Spec[]).map((s) => s.asset)) {
        this.changed.add(`Content/${a.split("/").slice(2).join("/")}.uasset`);
      }
    }
    return {
      ok,
      rolledBack: !ok,
      run,
      seconds: 0.5,
      assets,
      compile: { errors, warnings: [] },
    };
  }

  async compile(_mod: string, _assets: string[]): Promise<CompileReport> {
    this.calls.push({ tool: "bp_compile_report" });
    return { clean: this.reportMessages.length === 0, messages: this.reportMessages, run: "", seconds: 0.1 };
  }

  async reflect(): Promise<ReflectResult> {
    throw new Error("the fake backend does not reflect");
  }

  async gameTest(_mod: string, steps: unknown[], _o: { timeoutSeconds: number }): Promise<GameTestReport> {
    this.calls.push({ tool: "bp_game_test" });
    const failing = new Set(this.gameTestFailures[this.gameTestCalls++] ?? []);
    const report = steps.map((s, i) => {
      const op = String((s as { op?: unknown }).op ?? "step");
      return failing.has(i) ? { i, op, ok: false, value: "wrong" } : { i, op, ok: true, value: null };
    });
    return {
      ok: failing.size === 0,
      steps: report,
      passed: report.length - failing.size,
      failed: failing.size,
      complete: true,
      runtimeLog: [],
      run: "",
      seconds: 0.3,
      timedOut: false,
    };
  }

  async audit(_mod: string): Promise<AuditReport> {
    this.calls.push({ tool: "mod_audit" });
    return { ok: this.auditOk, raw: null, seconds: 0.2 };
  }

  async close(): Promise<void> {
    this.closed++;
  }

  private newRun(): string {
    const dir = join(this.root, `run-${++this.runs}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private nodeClass(s: SpecNode): string {
    switch (s.k) {
      case "call":
        return CLS.callFunction;
      case "get":
        return CLS.variableGet;
      case "set":
        return CLS.variableSet;
      case "event":
        return CLS.customEvent;
      case "branch":
        return CLS.branch;
      case "cast":
        return CLS.dynamicCast;
      case "node":
        return s.class ?? "";
      default:
        return CLS.callFunction;
    }
  }

  private makeNode(s: SpecNode, graph: string, castTyped: boolean): FNode {
    const cls = this.nodeClass(s);
    const head = [`NodePosX=${Math.round(s.pos[0])}`, `NodePosY=${Math.round(s.pos[1])}`];
    if (s.k === "call") {
      head.push(`FunctionReference=(${s.class ? `MemberParent="${s.class}",` : ""}MemberName="${s.function ?? ""}")`);
    } else if (s.k === "get" || s.k === "set") {
      head.push(`VariableReference=(${s.class ? `MemberParent="${s.class}",` : ""}MemberName="${s.name ?? ""}")`);
    } else if (s.k === "event") {
      head.push(`CustomFunctionName="${s.name ?? ""}"`);
    } else if (s.k === "cast") {
      head.push(`TargetType="${s.target ?? ""}"`);
    } else {
      head.push(...(s.props ?? []));
    }
    const node: FNode = { name: `${shortOf(cls)}_${++this.counter}`, cls, graph, head, pins: [] };
    for (const w of wildcardPins(cls)) wildcardPin(getPin(node, w.name, w.dir), w.container);
    if (cls === CLS.dynamicCast && castTyped) typePin(getPin(node, "Object", "in"), profile.castObjectPinType);
    for (const [pin, value] of Object.entries(s.set ?? {})) getPin(node, pin, "in").def = value;
    for (const [pin, path] of Object.entries(s.objects ?? {})) getPin(node, pin, "in").defObj = path;
    for (const [pin, type] of Object.entries(s.pin_types ?? {})) {
      const existing = node.pins.find((p) => p.name === pin);
      typePin(existing ?? getPin(node, pin, pin === "Output" || pin === "ReturnValue" ? "out" : "in"), type);
    }
    return node;
  }

  private applyGraph(a: FAsset, g: SpecGraph, castTyped: boolean, errors: CompileMessage[]): Record<string, string> {
    for (const r of g.remove ?? []) {
      const at = a.nodes.findIndex((n) => n.name === r && n.graph === g.graph);
      if (at < 0) {
        errors.push({ asset: a.path, message: `cannot remove ${r}: no such node in graph ${g.graph}` });
        continue;
      }
      a.nodes.splice(at, 1);
      for (const n of a.nodes) for (const p of n.pins) p.links = p.links.filter((l) => l.node !== r);
    }
    const ids: Record<string, string> = {};
    for (const s of g.add) {
      const node = this.makeNode(s, g.graph, castTyped);
      ids[s.id] = node.name;
      a.nodes.push(node);
      const ce = this.compileError;
      if (ce !== null && s.id === `${ce.unit ?? "UpdateTarget"}_${ce.irId}`) {
        errors.push({ asset: a.path, message: ce.message, node: node.name, graph: g.graph });
      }
    }
    const find = (end: string): { node: FNode; pin: string } => {
      const dot = end.indexOf(".");
      const name = ids[end.slice(0, dot)];
      const node = a.nodes.find((n) => n.name === name);
      if (node === undefined) throw new Error(`fake stage: wire end ${end} names no node of this spec`);
      return { node, pin: end.slice(dot + 1) };
    };
    for (const [from, to] of g.wires ?? []) {
      const f = find(from);
      const t = find(to);
      connect(f.node, f.pin, t.node, t.pin);
    }
    return ids;
  }
}
