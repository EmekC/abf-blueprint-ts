// Shared test helpers: the lowered step 23 fixture, capability sets and a recording fake backend.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHir, loadProgram, lower } from "@abfc/compiler";
import { loadProfile } from "@abfc/env";
import { parseBpType } from "@abfc/ir";
import type { ApplyPlan, BackendCapabilities, IrModule, Profile } from "@abfc/ir";
import { BP_APPLY_P1_BASE, effectivePinTypes, renderMainSpec, specNodeId } from "../src/index.js";
import type { Backend, BpApplyResult } from "../src/index.js";

// compiled to packages/backend/dist/test/ -> packages/compiler/test/fixtures/project
const projectDir = fileURLToPath(new URL("../../../compiler/test/fixtures/project", import.meta.url));

export const profile: Profile = loadProfile();

export function lowerFixture(): IrModule {
  const loaded = loadProgram(projectDir);
  const relay = loaded.files.classes.find((f) => f.fileName.endsWith("/Relay.ts"));
  if (relay === undefined) throw new Error("fixture Relay.ts not found");
  const hir = buildHir(loaded, { mod: "TestMod" }, profile, [relay]);
  if (hir.diagnostics.length > 0) throw new Error("fixture has diagnostics: " + JSON.stringify(hir.diagnostics));
  return lower(hir, profile);
}

export const ir: IrModule = lowerFixture();

export function caps(pinTypes: boolean, castObjectPin: boolean): BackendCapabilities {
  return { ...BP_APPLY_P1_BASE, protocol: 1, pinTypes, castObjectPin };
}

/** A plan that adds every unit of the fixture's first asset, origin (100, 200). */
export function planOf(module: IrModule): ApplyPlan {
  const a = module.assets[0]!;
  return {
    mod: module.mod,
    assets: [
      {
        asset: a.path,
        graphNodes: {},
        variables: a.variables,
        units: a.units.map((unit) => ({ unit, removeNodes: [], origin: [100, 200] as [number, number] })),
        classMeta: module.classMeta,
      },
    ],
  };
}

export interface RecordedCall {
  label: string;
  specs: Array<Record<string, any>>;
}

export type Responder = (call: RecordedCall, index: number) => BpApplyResult;

/** Backend whose `applySpecs` is scripted; every other method throws. */
export class FakeBackend implements Backend {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly respond: Responder) {}
  async applySpecs(_mod: string, specs: unknown[], o: { label: string }): Promise<BpApplyResult> {
    const call: RecordedCall = { label: o.label, specs: specs as Array<Record<string, any>> };
    this.calls.push(call);
    return this.respond(call, this.calls.length - 1);
  }
  private no(): never {
    throw new Error("not used by this test");
  }
  info(): Promise<never> { return this.no(); }
  stage(): Promise<never> { return this.no(); }
  stageStatus(): Promise<never> { return this.no(); }
  read(): Promise<never> { return this.no(); }
  compile(): Promise<never> { return this.no(); }
  reflect(): Promise<never> { return this.no(); }
  gameTest(): Promise<never> { return this.no(); }
  audit(): Promise<never> { return this.no(); }
  async close(): Promise<void> {}
}

export function result(over: Partial<BpApplyResult> = {}): BpApplyResult {
  return { ok: true, rolledBack: false, run: "", seconds: 0.5, assets: null, compile: { errors: [], warnings: [] }, ...over };
}

/** Real node name the fake backend gives to a spec node id. */
export const realName = (specId: string): string => `K2Node_Fake_${specId}`;

/** `node_ids` of one asset with one graph (`graph:0`): every spec node id of the plan -> `realName`. */
export function nodeIdsFor(plan: ApplyPlan, caps0: BackendCapabilities): Record<string, Record<string, string>> {
  const spec = renderMainSpec(plan.assets[0]!, caps0, profile);
  const map: Record<string, string> = {};
  for (const g of spec.graphs ?? []) for (const n of g.add) map[n.id] = realName(n.id);
  return { "graph:0": map };
}

export function tmpRun(): string {
  const dir = mkdtempSync(join(tmpdir(), "abfc-adapter-test-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

const WILD = 'PinType.PinCategory="wildcard",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None';
const TYPED_OBJECT = 'PinType.PinCategory="object",PinType.PinSubCategory="",PinType.PinSubCategoryObject="/Script/CoreUObject.Class\'/Script/CoreUObject.Object\'"';

function pinLine(id: string, name: string, type: string, container: string): string {
  return (
    `CustomProperties Pin (PinId=${id},PinName="${name}",${type},PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),` +
    `PinType.ContainerType=${container},PinType.bIsReference=False,PersistentGuid=00000000000000000000000000000000,bHidden=False,)`
  );
}

/**
 * The editor export a backend would write after phase A: one EventGraph with a node (`realName(specId)`) for every node of the
 * plan that has pin types; the pins the backend does not type itself (`effectivePinTypes`) are wildcards, the others carry
 * the cast `Object` type.
 */
export function syntheticFinal(plan: ApplyPlan, caps0: BackendCapabilities): string {
  const nodes: string[] = [];
  let k = 0;
  for (const u of plan.assets[0]!.units) {
    for (const n of u.unit.nodes) {
      const wanted = Object.entries(n.pinTypes ?? {});
      if (wanted.length === 0) continue;
      const effective = effectivePinTypes(n, caps0, profile);
      const name = realName(specNodeId(u.unit, n.id));
      const pins = wanted.map(([pin, type]) => {
        k++;
        const id = k.toString(16).padStart(32, "0").toUpperCase();
        const container = parseBpType(type).container;
        return pinLine(id, pin, pin in effective ? WILD : TYPED_OBJECT, container);
      });
      nodes.push(name + "\u0000" + pins.join("\u0001"));
    }
  }
  const bp = "/TestMod/Relay/BP_Relay.BP_Relay";
  const lines = [
    `Begin Object Class=/Script/Engine.Blueprint Name="BP_Relay" ExportPath="/Script/Engine.Blueprint'${bp}'"`,
    `   Begin Object Class=/Script/Engine.EdGraph Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${bp}:EventGraph'"`,
    ...nodes.flatMap((n) => [
      `      Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="${n.split("\u0000")[0]}" ExportPath="/Script/BlueprintGraph.K2Node_CallFunction'${bp}:EventGraph.${n.split("\u0000")[0]}'"`,
      "      End Object",
    ]),
    "   End Object",
    `   Begin Object Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${bp}:EventGraph'"`,
    ...nodes.flatMap((n) => {
      const [name, pins] = n.split("\u0000") as [string, string];
      return [
        `      Begin Object Name="${name}" ExportPath="/Script/BlueprintGraph.K2Node_CallFunction'${bp}:EventGraph.${name}'"`,
        "         NodePosX=0",
        "         NodePosY=0",
        ...pins.split("\u0001").map((p) => `         ${p}`),
        "      End Object",
      ];
    }),
    "   End Object",
    "End Object",
    "",
  ];
  return lines.join("\n");
}

/** Writes `final_0.t3d` of the synthetic export into a fresh run folder and returns the folder. */
export function writeFinal(plan: ApplyPlan, caps0: BackendCapabilities): string {
  const run = tmpRun();
  writeFileSync(join(run, "final_0.t3d"), syntheticFinal(plan, caps0), "utf8");
  return run;
}
