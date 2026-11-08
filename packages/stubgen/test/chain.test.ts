import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { loadProfile } from "@abfc/env";
import {
  auditStubChains,
  classChain,
  classesWithoutSupers,
  emitStubsWithIndex,
  missingAncestors,
  rulesFromPairs,
  writeStubs,
  writeTsconfigPaths,
} from "../src/index.js";
import type { EmitInput, ReflectClass, ReflectData, ReflectPin } from "../src/index.js";

const OBJ = "/Script/CoreUObject.Object";
const ACTOR = "/Script/FakeEngine.FakeActor";
const CTRL = "/Script/FakeEngine.FakeController";
const PC = "/Script/FakeEngine.FakePlayerController";
const GPC = "/Script/FakeGame.GamePlayerController";
const BPC = "/Game/Fake/BP_PlayerController.BP_PlayerController_C";
const BPBASE = "/Game/Fake/BP_Base.BP_Base_C";
const BPCHILD = "/Game/Fake/BP_Child.BP_Child_C";
const UW = "/Script/FakeUMG.UserWidget";
const WBP = "/Game/Fake/W_Panel.W_Panel_C";
const SLOT = "/Game/Fake/W_Slot.W_Slot_C";
const MYSTERY = "/Script/FakeGame.Mystery";

function pin(name: string, dir: "in" | "out", category: string, extra: Partial<ReflectPin> = {}): ReflectPin {
  return { name, dir, category, subCategory: "", subCategoryObject: null, objectMeta: null, container: "None", hidden: false, default: null, ...extra };
}
const objectPin = (name: string, path: string): ReflectPin => pin(name, "out", "object", { subCategoryObject: path });

/** A function with a self pin and an int return, the shape of a pure BlueprintCallable getter. */
const getter = (name: string, owner: string): ReflectClass["functions"][number] => ({
  name,
  pins: [pin("self", "in", "object", { subCategoryObject: owner }), pin("ReturnValue", "out", "int")],
});

function cls(ancestors: string[], functions: ReflectClass["functions"] = [], properties: ReflectClass["properties"] = [], blueprint = false): ReflectClass {
  return {
    meta: blueprint ? "/Script/Engine.BlueprintGeneratedClass" : "/Script/CoreUObject.Class",
    ancestors,
    castPin: null,
    properties,
    functions,
  };
}

const BPC_CHAIN = [GPC, PC, CTRL, ACTOR, OBJ];

function playerControllerData(): ReflectData {
  return {
    engineVersion: "5.4.4-fake",
    classes: {
      [ACTOR]: cls([OBJ], [getter("GetOwner", ACTOR)]),
      [CTRL]: cls([ACTOR, OBJ], [getter("K2_GetPawn", CTRL)]),
      [PC]: cls([CTRL, ACTOR, OBJ], [getter("IsLocalController", PC)]),
      [GPC]: cls([PC, CTRL, ACTOR, OBJ], [getter("GameOnly", GPC)]),
      [BPC]: cls([GPC, PC, CTRL, ACTOR, OBJ], [], [], true),
    },
    structs: {},
    supers: { [BPC]: BPC_CHAIN },
    errors: [],
  };
}

function input(reflect: ReflectData): EmitInput {
  return {
    profile: loadProfile(),
    reflect,
    filter: { contentVersion: "v1", rules: rulesFromPairs([]) },
    manual: [],
    mod: "TestMod",
    opaque: [],
  };
}

function checkProgram(files: Map<string, string>, consumer: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "abfc-chain-test-"));
  try {
    const abfcDir = join(dir, ".abfc");
    writeStubs(join(abfcDir, "stubs", "p1"), files);
    const req = createRequire(import.meta.url);
    const dts = (spec: string): string => req.resolve(spec).replace(/\.js$/, ".d.ts");
    writeTsconfigPaths(abfcDir, "p1", "TestMod", dts("@abfc/runtime"), dts("@abfc/ir"));
    writeFileSync(join(dir, "consumer.ts"), consumer);
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "./.abfc/tsconfig.paths.json",
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", target: "es2023", strict: true, noEmit: true, types: [] },
        files: ["consumer.ts"],
      }),
    );
    const parsed = ts.getParsedCommandLineOfConfigFile(join(dir, "tsconfig.json"), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      },
    });
    assert.ok(parsed, "tsconfig did not parse");
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
    return ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file ? `${d.file.fileName.replace(dir, "")}:${d.start ?? 0}` : "";
      return `TS${d.code} ${where} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a Blueprint -> native game class -> engine chain deeper than 2 is emitted whole", () => {
  const { files, index } = emitStubsWithIndex(input(playerControllerData()));
  const game = files.get("Script/FakeGame.d.ts") ?? "";
  const engine = files.get("Script/FakeEngine.d.ts") ?? "";
  assert.match(files.get("Game/Fake/BP_PlayerController.d.ts") ?? "", /export declare class BP_PlayerController_C extends GamePlayerController \{/);
  assert.match(game, /export declare class GamePlayerController extends FakePlayerController \{/);
  assert.match(engine, /export declare class FakePlayerController extends FakeController \{/);
  assert.match(engine, /export declare class FakeController extends FakeActor \{/);
  assert.match(engine, /export declare class FakeActor extends UObject \{/);
  for (const text of [game, engine, files.get("Game/Fake/BP_PlayerController.d.ts") ?? ""]) assert.doesNotMatch(text, /@bpOpaque/);
  assert.deepEqual(index.chainGaps, []);
  assert.deepEqual(index.noSupers, []);
  assert.deepEqual(index.opaqueNoParent, []);

  const consumer = `
import type { BP_PlayerController_C } from "/Game/Fake/BP_PlayerController";
declare const bpc: BP_PlayerController_C;
const a: number = bpc.IsLocalController();
const b: number = bpc.K2_GetPawn();
const c: number = bpc.GetOwner();
const d: number = bpc.GameOnly();
void [a, b, c, d];
`;
  assert.deepEqual(checkProgram(files, consumer), []);
});

test("a /Game parent Blueprint beyond depth is the real parent", () => {
  const data: ReflectData = {
    engineVersion: "5.4.4-fake",
    classes: {
      [ACTOR]: cls([OBJ], [getter("GetOwner", ACTOR)]),
      [BPBASE]: cls([ACTOR, OBJ], [getter("BaseOnly", BPBASE)], [], true),
      [BPCHILD]: cls([ACTOR, OBJ], [], [], true),
    },
    structs: {},
    supers: { [BPCHILD]: [BPBASE, ACTOR, OBJ], [BPBASE]: [ACTOR, OBJ] },
    errors: [],
  };
  const { files, index } = emitStubsWithIndex(input(data));
  assert.match(files.get("Game/Fake/BP_Child.d.ts") ?? "", /export declare class BP_Child_C extends BP_Base_C \{/);
  assert.match(files.get("Game/Fake/BP_Base.d.ts") ?? "", /export declare class BP_Base_C extends FakeActor \{/);
  assert.deepEqual(index.chainGaps, []);
  assert.deepEqual(index.noSupers, []);
  const consumer = `
import type { BP_Child_C } from "/Game/Fake/BP_Child";
declare const c: BP_Child_C;
const a: number = c.BaseOnly();
const b: number = c.GetOwner();
void [a, b];
`;
  assert.deepEqual(checkProgram(files, consumer), []);
});

test("a widget Blueprint extends UserWidget", () => {
  const data: ReflectData = {
    engineVersion: "5.4.4-fake",
    classes: { [UW]: cls([OBJ]), [WBP]: cls([UW, OBJ], [], [], true) },
    structs: {},
    supers: { [WBP]: [UW, OBJ] },
    errors: [],
  };
  const { files, index } = emitStubsWithIndex(input(data));
  assert.match(files.get("Game/Fake/W_Panel.d.ts") ?? "", /export declare class W_Panel_C extends UserWidget \{/);
  const umg = files.get("Script/FakeUMG.d.ts") ?? "";
  assert.match(umg, /export declare class UserWidget extends UObject \{/);
  assert.doesNotMatch(umg, /@bpOpaque/);
  assert.deepEqual(index.chainGaps, []);
});

test("old backend: no supers -> nearest native ancestor, noSupers lists the Blueprint", () => {
  const data: ReflectData = {
    engineVersion: "5.4.4-fake",
    classes: { [ACTOR]: cls([OBJ], [getter("GetOwner", ACTOR)]), [BPCHILD]: cls([ACTOR, OBJ], [], [], true) },
    structs: {},
    errors: [],
  };
  const { files, index } = emitStubsWithIndex(input(data));
  assert.match(files.get("Game/Fake/BP_Child.d.ts") ?? "", /export declare class BP_Child_C extends FakeActor \{/);
  assert.deepEqual(index.noSupers, [BPCHILD]);
  assert.deepEqual(index.chainGaps, []);
});

test("opaque member types stay opaque but parent-correct", () => {
  const data: ReflectData = {
    engineVersion: "5.4.4-fake",
    classes: {
      [UW]: cls([OBJ]),
      [ACTOR]: cls([OBJ], [], [{ name: "Slot", pins: [objectPin("Slot", SLOT)] }, { name: "Odd", pins: [objectPin("Odd", MYSTERY)] }]),
    },
    structs: {},
    supers: { [SLOT]: [UW, OBJ] },
    errors: [],
  };
  const { files, index } = emitStubsWithIndex(input(data));
  const slot = files.get("Game/Fake/W_Slot.d.ts") ?? "";
  assert.match(slot, /@bpOpaque/);
  assert.match(slot, /export declare class W_Slot_C extends UserWidget \{\}/);
  const game = files.get("Script/FakeGame.d.ts") ?? "";
  assert.match(game, /@bpOpaque/);
  assert.match(game, /export declare class Mystery extends UObject \{\}/);
  assert.deepEqual(index.opaqueNoParent, [MYSTERY]);
  assert.deepEqual(index.chainGaps, []);
});

test("an unreflected chain entry is opaque with its known parent and reported", () => {
  const data = playerControllerData();
  delete data.classes[GPC];
  const { files, index } = emitStubsWithIndex(input(data));
  assert.match(files.get("Game/Fake/BP_PlayerController.d.ts") ?? "", /export declare class BP_PlayerController_C extends GamePlayerController \{/);
  const game = files.get("Script/FakeGame.d.ts") ?? "";
  assert.match(game, /@bpOpaque/);
  assert.match(game, /export declare class GamePlayerController extends FakePlayerController \{\}/);
  assert.match(files.get("Script/FakeEngine.d.ts") ?? "", /export declare class FakePlayerController extends FakeController \{/);
  assert.deepEqual(index.chainGaps, [`${BPC} -> ${GPC} (opaque)`]);
  assert.deepEqual(index.opaqueNoParent, []);
});

test("classChain prefers supers, falls back to ancestors and drops the class itself", () => {
  const data = playerControllerData();
  assert.deepEqual(classChain(data, BPC), BPC_CHAIN);
  assert.deepEqual(classChain(data, PC), [CTRL, ACTOR, OBJ]);
  assert.deepEqual(classChain(data, "/Script/FakeGame.Unknown"), []);
  const selfListed: ReflectData = { engineVersion: "5.4.4-fake", classes: { [ACTOR]: cls([ACTOR, OBJ]) }, structs: {}, errors: [] };
  assert.deepEqual(classChain(selfListed, ACTOR), [OBJ]);
});

test("missingAncestors / classesWithoutSupers", () => {
  const data = playerControllerData();
  delete data.classes[GPC];
  delete data.classes[PC];
  assert.deepEqual(missingAncestors(data), [PC, GPC]);
  assert.deepEqual(missingAncestors(data, ["/TestMod/Items/BP_Hand.BP_Hand_C", "/TestMod/Items/Parent.Parent_C"]), [PC, GPC]);
  assert.deepEqual(missingAncestors(data, [], new Set([GPC])), [PC]);
  // A castOnly entry has no members, so it still counts as missing, and it is not a source of further ancestors.
  data.classes[PC] = { ...cls([CTRL, ACTOR, OBJ]), castOnly: true };
  data.classes["/Script/FakeGame.Orphan"] = { ...cls(["/Script/FakeGame.Never", OBJ]), castOnly: true };
  assert.deepEqual(missingAncestors(data), [PC, GPC]);
  // Roots are themselves part of the closure.
  assert.deepEqual(missingAncestors(playerControllerData(), [UW]), [UW]);

  const refs: ReflectData = {
    engineVersion: "5.4.4-fake",
    classes: {
      [ACTOR]: cls(
        [OBJ],
        [],
        [
          { name: "Own", pins: [objectPin("Own", ACTOR)] },
          { name: "Slot", pins: [objectPin("Slot", SLOT)] },
          { name: "Odd", pins: [objectPin("Odd", MYSTERY)] },
          { name: "Known", pins: [objectPin("Known", UW)] },
          { name: "Mod", pins: [objectPin("Mod", "/TestMod/Items/BP_Hand.BP_Hand_C")] },
        ],
      ),
    },
    structs: {},
    supers: { [UW]: [OBJ] },
    errors: [],
  };
  assert.deepEqual(classesWithoutSupers(refs), [SLOT, MYSTERY]);
  assert.deepEqual(classesWithoutSupers(refs, [{ kind: "class", path: CTRL }, { kind: "struct", path: "/Script/FakeEngine.FakeVec" }]), [SLOT, CTRL, MYSTERY]);
});

test("auditStubChains", () => {
  const { files } = emitStubsWithIndex(input(playerControllerData()));
  const ok = auditStubChains(files);
  assert.deepEqual(ok.findings.filter((f) => f.kind !== "unknown-parent"), []);
  assert.ok(ok.classes >= 5);

  // The old bug: a Blueprint extending a placeholder class (imported under an alias) that extends UObject.
  const bad = new Map<string, string>([
    [
      "Script/FakeGame.d.ts",
      [
        'import type { UObject } from "/Script/CoreUObject";',
        "",
        "/**",
        " * @bpPath /Script/FakeGame.GamePlayerController",
        " * @bpOpaque",
        " */",
        "export declare class GamePlayerController extends UObject {}",
        "",
      ].join("\n"),
    ],
    [
      "Script/CoreUObject.d.ts",
      ["/**", " * @bpPath /Script/CoreUObject.Object", " */", "export declare class UObject {", "}", ""].join("\n"),
    ],
    [
      "Game/Fake/BP_Bad.d.ts",
      [
        'import type { GamePlayerController as FakeGame_GamePlayerController } from "/Script/FakeGame";',
        'import type { Missing } from "/Script/FakeGame";',
        "",
        "/**",
        " * @bpPath /Game/Fake/BP_Bad.BP_Bad_C",
        " */",
        "export declare class BP_Bad_C extends FakeGame_GamePlayerController {",
        "}",
        "",
        "/**",
        " * @bpPath /Game/Fake/BP_Lost.BP_Lost_C",
        " */",
        "export declare class BP_Lost_C extends Missing {",
        "}",
        "",
      ].join("\n"),
    ],
  ]);
  const audit = auditStubChains(bad);
  assert.equal(audit.classes, 4);
  assert.equal(audit.opaque, 1);
  assert.deepEqual(
    audit.findings.map((f) => [f.kind, f.cls, f.detail]),
    [
      ["opaque-ancestor", "/Game/Fake/BP_Bad.BP_Bad_C", "/Script/FakeGame.GamePlayerController"],
      ["unresolved-parent", "/Game/Fake/BP_Lost.BP_Lost_C", "Missing"],
      ["unknown-parent", "/Script/FakeGame.GamePlayerController", "extends UObject; the real parent is not known"],
    ],
  );
});

test("castOnly entries are not audited; an old backend's far native ancestors that were not reflected become opaque shells", () => {
  const data: ReflectData = {
    engineVersion: "5.4.4-fake",
    classes: {
      // Cast-only: no members, its chain is not reflected and not reported.
      [BPBASE]: { ...cls([GPC, ACTOR, OBJ], [], [], true), castOnly: true },
      // No `supers`: the native `ancestors` name a class (GPC) that was never reflected.
      [BPCHILD]: cls([GPC, ACTOR, OBJ], [], [], true),
      [ACTOR]: cls([OBJ]),
    },
    structs: {},
    errors: [],
  };
  const { files, index } = emitStubsWithIndex(input(data));
  assert.deepEqual(index.chainGaps, [`${BPCHILD} -> ${GPC} (opaque)`]);
  assert.deepEqual(index.noSupers, [BPCHILD]);
  assert.match(files.get("Script/FakeGame.d.ts") ?? "", /export declare class GamePlayerController extends FakeActor \{\}/);
});

test("discovered widget, component and plain members: declared once, readonly where designer-owned, no TS2416/TS2417 on the chain", () => {
  const HUD = "/Game/Fake/W_Hud.W_Hud_C";
  const TEXT = "/Script/FakeUMG.TextBlock";
  const MESH = "/Script/FakeEngine.FakeMeshComponent";
  const member = (name: string, kind: "widget" | "component" | "member", type: string): ReflectClass["properties"][number] => ({ name, kind, pins: [objectPin(name, type)] });
  const data: ReflectData = {
    engineVersion: "5.4.4-fake",
    classes: {
      [ACTOR]: cls([OBJ], [getter("GetOwner", ACTOR)]),
      [BPBASE]: cls([ACTOR, OBJ], [], [member("Shared", "member", HUD), member("Arms", "component", MESH), { name: "Count", pins: [pin("Count", "out", "int")] }], true),
      [BPCHILD]: cls(
        [ACTOR, OBJ],
        [],
        [member("shared", "member", HUD), member("TitleText", "widget", TEXT), member("HudRef", "member", HUD), member("Arms", "component", MESH), { name: "Count", pins: [pin("Count", "out", "int")] }],
        true,
      ),
    },
    structs: {},
    supers: { [BPCHILD]: [BPBASE, ACTOR, OBJ], [BPBASE]: [ACTOR, OBJ] },
    errors: [],
  };
  const { files, index } = emitStubsWithIndex(input(data));
  const base = files.get("Game/Fake/BP_Base.d.ts") ?? "";
  const child = files.get("Game/Fake/BP_Child.d.ts") ?? "";
  assert.match(base, /^ {2}Shared: W_Hud_C \| null;$/m);
  assert.doesNotMatch(base, /readonly Shared/);
  assert.match(base, /^ {2}readonly Arms: FakeMeshComponent \| null;$/m);
  assert.match(base, / \* @bpComponent/);
  assert.doesNotMatch(base, /@bpWidget|@bpHandMade/);
  assert.match(child, /^ {2}readonly TitleText: TextBlock \| null;$/m);
  assert.match(child, / \* @bpWidget/);
  assert.match(child, /^ {2}HudRef: W_Hud_C \| null;$/m);
  assert.doesNotMatch(child, /@bpHandMade|@bpComponent/);
  // Inherited members (any case) are not repeated on the subclass; ordinary properties keep today's behavior.
  assert.doesNotMatch(child, /Shared|Arms/i);
  assert.match(child, /^ {2}Count: int;$/m);
  assert.deepEqual(index.discovered, [`${BPBASE}:Arms (component)`, `${BPBASE}:Shared (member)`, `${BPCHILD}:HudRef (member)`, `${BPCHILD}:TitleText (widget)`]);
  assert.deepEqual(index.chainGaps, []);
  const consumer = `
import type { BP_Child_C } from "/Game/Fake/BP_Child";
import type { W_Hud_C } from "/Game/Fake/W_Hud";
declare const c: BP_Child_C;
declare const hud: W_Hud_C;
const a = c.Shared;
const b = c.Arms;
const t = c.TitleText;
c.HudRef = hud;
c.Shared = hud;
// @ts-expect-error designer widgets are read-only
c.TitleText = t;
// @ts-expect-error components are read-only
c.Arms = b;
void [a, b, t];
`;
  assert.deepEqual(checkProgram(files, consumer), []);
});
