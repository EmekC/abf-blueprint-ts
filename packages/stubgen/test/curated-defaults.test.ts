import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProfile } from "@abfc/env";
import { emitStubs, rulesFromPairs } from "../src/index.js";
import { CURATED_DEFAULTS } from "../src/curated.js";
import type { EmitInput, ReflectData, ReflectPin } from "../src/index.js";

type PinExtra = Partial<Omit<ReflectPin, "name" | "dir" | "category">>;
function pin(name: string, dir: "in" | "out", category: string, extra: PinExtra = {}): ReflectPin {
  return { name, dir, category, subCategory: "", subCategoryObject: null, objectMeta: null, container: "None", hidden: false, default: null, ...extra };
}

const ENGINE = "/Script/Engine";
const STATICS = `${ENGINE}.GameplayStatics`;
const ACTOR = `${ENGINE}.Actor`;
const VECTOR = "/Script/CoreUObject.Vector";
const hiddenSelf = (): ReflectPin => pin("self", "in", "object", { subCategoryObject: STATICS, hidden: true });
const actorSelf = (): ReflectPin => pin("self", "in", "object", { subCategoryObject: ACTOR });
const execIn = (): ReflectPin => pin("execute", "in", "exec");
const execThen = (): ReflectPin => pin("then", "out", "exec");

function reflect(defaults: { playerIndex?: Record<string, string> | null; sweep?: Record<string, string> | null } = {}): ReflectData {
  return {
    engineVersion: "5.4.4-fake",
    classes: {
      [STATICS]: {
        meta: "/Script/CoreUObject.Class",
        ancestors: ["/Script/CoreUObject.Object"],
        castPin: null,
        properties: [],
        functions: [
          {
            name: "GetPlayerCharacter",
            pins: [
              hiddenSelf(),
              pin("WorldContextObject", "in", "object", { subCategoryObject: "/Script/CoreUObject.Object", hidden: true }),
              pin("PlayerIndex", "in", "int"),
              pin("ReturnValue", "out", "object", { subCategoryObject: ACTOR }),
            ],
            meta: defaults.playerIndex === undefined ? null : { defaults: defaults.playerIndex },
          },
          {
            // a function that is not curated: the int stays required
            name: "GetPlayerState",
            pins: [hiddenSelf(), pin("PlayerStateIndex", "in", "int"), pin("ReturnValue", "out", "object", { subCategoryObject: ACTOR })],
          },
        ],
      },
      [ACTOR]: {
        meta: "/Script/CoreUObject.Class",
        ancestors: ["/Script/CoreUObject.Object"],
        castPin: null,
        properties: [],
        functions: [
          {
            name: "K2_SetActorLocation",
            pins: [
              execIn(),
              actorSelf(),
              execThen(),
              pin("NewLocation", "in", "struct", { subCategoryObject: VECTOR }),
              pin("bSweep", "in", "bool"),
              pin("bTeleport", "in", "bool"),
              pin("ReturnValue", "out", "bool"),
            ],
            meta: defaults.sweep === undefined ? null : { defaults: defaults.sweep },
          },
          {
            // the curated pins are not the trailing run here: Extra has no default, so everything stays required
            name: "K2_AddActorWorldOffset",
            pins: [
              execIn(),
              actorSelf(),
              execThen(),
              pin("DeltaLocation", "in", "struct", { subCategoryObject: VECTOR }),
              pin("bSweep", "in", "bool"),
              pin("bTeleport", "in", "bool"),
              pin("Extra", "in", "int"),
            ],
          },
          {
            // not curated: a trailing bool without a default stays required (no general rule)
            name: "SetActorHiddenInGame",
            pins: [execIn(), actorSelf(), execThen(), pin("bNewHidden", "in", "bool")],
          },
        ],
      },
      [VECTOR]: { meta: "/Script/CoreUObject.ScriptStruct", ancestors: [], castPin: null, properties: [], functions: [] },
    },
    structs: { [VECTOR]: { fields: [pin("X", "out", "real", { subCategory: "double" })] } },
    errors: [],
  };
}

function input(r: ReflectData): EmitInput {
  return { profile: loadProfile(), reflect: r, filter: { contentVersion: "v1", rules: rulesFromPairs([]) }, manual: [], mod: "TestMod", opaque: [] };
}

function engineText(r: ReflectData): string {
  return emitStubs(input(r)).get("Script/Engine.d.ts") ?? "";
}

test("every curated value is the K2 zero text of its pin (bool false, int 0)", () => {
  const keys = Object.keys(CURATED_DEFAULTS);
  assert.ok(keys.length > 0);
  for (const [key, pins] of Object.entries(CURATED_DEFAULTS)) {
    assert.match(key, /^\/Script\/Engine\.[A-Za-z]+:[A-Za-z0-9_]+$/);
    for (const [name, value] of Object.entries(pins)) {
      const isBool = /^b[A-Z]/.test(name);
      assert.equal(value, isBool ? "false" : "0", `${key} ${name}`);
      if (!isBool) assert.match(name, /Index$/, `${key} ${name}: only player indexes are curated as int`);
    }
  }
});

test("a reflected function without metadata defaults gets the curated optional parameters and @bpDefault", () => {
  const text = engineText(reflect());
  assert.match(text, /function GetPlayerCharacter\(PlayerIndex\?: int\): /);
  assert.match(text, /@bpDefault PlayerIndex "0"/);
  assert.match(text, /K2_SetActorLocation\(NewLocation: Vector, bSweep\?: boolean, bTeleport\?: boolean\)/);
  assert.match(text, /@bpDefault bSweep "false"/);
  assert.match(text, /@bpDefault bTeleport "false"/);
  // the same with an unreadable (null) or empty metadata read
  assert.match(engineText(reflect({ playerIndex: null, sweep: {} })), /function GetPlayerCharacter\(PlayerIndex\?: int\)/);
});

test("functions that are not curated keep required parameters", () => {
  const text = engineText(reflect());
  assert.match(text, /function GetPlayerState\(PlayerStateIndex: int\)/);
  assert.match(text, /SetActorHiddenInGame\(bNewHidden: boolean\)/);
  assert.ok(!/@bpDefault bNewHidden/.test(text));
});

test("a backend default wins over the curated one", () => {
  const text = engineText(reflect({ playerIndex: { PlayerIndex: "2" }, sweep: { bSweep: "true", bTeleport: "false" } }));
  assert.match(text, /@bpDefault PlayerIndex "2"/);
  assert.ok(!/@bpDefault PlayerIndex "0"/.test(text));
  assert.match(text, /@bpDefault bSweep "true"/);
  assert.match(text, /@bpDefault bTeleport "false"/);
});

test("a curated pin that is not in the trailing run of defaulted pins stays required", () => {
  const text = engineText(reflect());
  assert.match(text, /K2_AddActorWorldOffset\(DeltaLocation: Vector, bSweep: boolean, bTeleport: boolean, Extra: int\)/);
  const block = text.split("@bpPath /Script/Engine.Actor:K2_AddActorWorldOffset")[1]?.split("*/")[0] ?? "";
  assert.ok(block.includes("@bpParam bSweep bool"));
  assert.ok(!block.includes("@bpDefault"));
});
