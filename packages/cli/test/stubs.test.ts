import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbfcError } from "@abfc/env";
import type { Backend, ReflectData, ReflectRequest, ReflectResult } from "@abfc/backend";
import { main } from "../src/index.js";
import { ALL_TOOLS, captureDeps, fakeEnvironmentFiles, fixInfo, scriptedBackend } from "./helpers.js";

const THING = "/Script/FakeEngine.Thing";
const VEC = "/Script/FakeEngine.FakeVec";
const EXT = { extProtocol: 1, serverVersion: "fake-1", python: "3.11.9", features: ["reflect"] };

const pin = (name: string, dir: "in" | "out", category: string, extra: Record<string, unknown> = {}) => ({
  name,
  dir,
  category,
  subCategory: "",
  subCategoryObject: null,
  objectMeta: null,
  container: "None",
  hidden: false,
  default: null,
  ...extra,
});

const firstData: ReflectData = {
  engineVersion: "5.4.4-fake",
  classes: {
    [THING]: {
      meta: "/Script/CoreUObject.Class",
      ancestors: ["/Script/CoreUObject.Object"],
      castPin: "AsThing",
      properties: [{ name: "Origin", pins: [pin("Origin", "out", "struct", { subCategoryObject: VEC })] }],
      functions: [],
    },
  },
  structs: {},
  errors: [],
};
const secondData: ReflectData = {
  engineVersion: "5.4.4-fake",
  classes: {},
  structs: { [VEC]: { fields: [pin("X", "out", "real", { subCategory: "double" })] } },
  errors: [],
};

const EXPORT = [
  "Begin Object Class=/Script/Engine.Blueprint Name=\"BP_Hand\" ExportPath=\"/Script/Engine.Blueprint'/TestMod/Items/BP_Hand.BP_Hand'\"",
  "   ParentClass=\"/Script/CoreUObject.Class'/Script/FakeEngine.Thing'\"",
  "   NewVariables(0)=(VarName=\"Hp\",VarType=(PinCategory=\"int\",PinSubCategory=\"\",PinSubCategoryObject=None,ContainerType=None),DefaultValue=\"0\")",
  "End Object",
].join("\n");
const EXPORT_PATH = "C:\\Runs\\r1\\export.t3d";

async function fakeBackend(withReflect: boolean, calls: ReflectRequest[], reads: string[]): Promise<Backend> {
  const tools = withReflect ? ALL_TOOLS : ALL_TOOLS.filter((t) => t !== "reflect");
  const real = scriptedBackend(tools, { backend_info: fixInfo(), abfc_extensions: EXT });
  const info = await real.info();
  const result = (data: ReflectData): ReflectResult => ({
    run: "C:\\Runs\\r1",
    seconds: 0.1,
    file: "C:\\Runs\\r1\\reflect.json",
    data,
    filter: { contentVersion: "v1", rules: [["Block", `${THING} Hidden`]] },
  });
  return {
    info: async () => info,
    stage: async () => ({ mod: "TestMod", files: 1, stagingPath: "C:\\Stage" }),
    stageStatus: async () => ({ mod: "TestMod", stagingPath: "C:\\Stage", syncedAt: "t", changed: [], added: [], removed: [], conflicts: [] }),
    read: async (_mod, asset) => {
      reads.push(asset);
      if (asset.endsWith("Missing")) throw new Error("read failed");
      if (asset.endsWith("Data")) {
        throw new AbfcError({ severity: "error", code: "ABFC4002", message: `backend tool "bp_read" failed: ${asset} is not a Blueprint (DataAsset)` });
      }
      return { asset, run: "C:\\Runs\\r1", exportPath: EXPORT_PATH, structure: { blueprint: { class: "Blueprint" }, functions: [] }, seconds: 1 };
    },
    applySpecs: async () => {
      throw new Error("unused");
    },
    compile: async () => {
      throw new Error("unused");
    },
    reflect: async (r) => {
      calls.push(r);
      return result(calls.length === 1 ? firstData : secondData);
    },
    gameTest: async () => {
      throw new Error("unused");
    },
    audit: async () => {
      throw new Error("unused");
    },
    publish: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
}

function setup(tmp: string, modAssets: "all" | string[]) {
  const fake = fakeEnvironmentFiles({
    projectConfig: { stubs: { classes: ["/Game/Fake/BP_Fake.BP_Fake_C"], scriptClasses: [THING], modAssets } },
    extraFiles: {
      [join(tmp, "abf.config.json")]: JSON.stringify({
        mod: { name: "TestMod" },
        backend: { kind: "bp_apply", minProtocol: 1 },
        stubs: { classes: ["/Game/Fake/BP_Fake.BP_Fake_C"], scriptClasses: [THING], modAssets },
      }),
      [EXPORT_PATH]: EXPORT,
    },
  });
  // Mod assets on the (fake) disk: one real blueprint, one scratch folder entry that must be skipped, one that fails to read, one that is not a Blueprint.
  const content = `${fake.modDir}\\Content`;
  fake.files[`${content}\\Items\\BP_Hand.uasset`] = "x";
  fake.files[`${content}\\_McpTest\\BP_Scratch.uasset`] = "x";
  fake.files[`${content}\\Items\\Missing.uasset`] = "x";
  fake.files[`${content}\\Items\\Data.uasset`] = "x";
  return fake;
}

test("abfc stubs: reflect closure, mod assets, files, lock, paths and timings", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, "all");
    const calls: ReflectRequest[] = [];
    const reads: string[] = [];
    const cap = captureDeps(fake, () => fakeBackend(true, calls, reads));
    cap.deps.cwd = tmp;
    const code = await main(["stubs"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);

    assert.equal(calls.length, 2, "one reflect for the classes, one for the struct closure");
    assert.deepEqual(calls[0]?.classes, ["/Game/Fake/BP_Fake.BP_Fake_C", THING]);
    assert.deepEqual(calls[0]?.castTargets, ["/Game/Fake/BP_Fake.BP_Fake_C"]);
    assert.deepEqual(calls[1]?.structs, [VEC]);
    assert.deepEqual(reads, ["/TestMod/Items/BP_Hand", "/TestMod/Items/Data", "/TestMod/Items/Missing"]);
    assert.match(out, /warning ABFC4002: could not read \/TestMod\/Items\/Missing/);
    // An asset the backend says is not a Blueprint is skipped without a warning.
    assert.doesNotMatch(out, /Items\/Data/);
    assert.equal((out.match(/ABFC4002/g) ?? []).length, 1, out);

    const dir = join(tmp, ".abfc", "stubs", "ue5.4.4-1050002");
    const script = readFileSync(join(dir, "Script", "FakeEngine.d.ts"), "utf8");
    assert.match(script, /export declare class Thing extends UObject/);
    assert.match(script, /export declare interface FakeVec/);
    const hand = readFileSync(join(dir, "Mod", "TestMod", "Items", "BP_Hand.d.ts"), "utf8");
    assert.match(hand, /^ {2}Hp: int;$/m);
    assert.ok(existsSync(join(dir, "Script", "CoreUObject.d.ts")));

    const lock = JSON.parse(readFileSync(join(dir, "stubs.lock.json"), "utf8")) as Record<string, unknown>;
    assert.equal(lock.profile, "ue5.4.4-1050002");
    assert.equal(lock.engineVersion, "5.4.4-fake");
    assert.equal(lock.filterContentVersion, "v1");
    assert.deepEqual(lock.modAssets, ["/TestMod/Items/BP_Hand"]);
    const index = JSON.parse(readFileSync(join(dir, "_index.json"), "utf8")) as { files: string[]; opaque: string[] };
    assert.ok(index.files.includes("Script/FakeEngine.d.ts"));

    const paths = JSON.parse(readFileSync(join(tmp, ".abfc", "tsconfig.paths.json"), "utf8")) as { compilerOptions: { paths: Record<string, string[]> } };
    assert.deepEqual(paths.compilerOptions.paths["/Script/*"], ["./stubs/ue5.4.4-1050002/Script/*.js"]);
    assert.match(paths.compilerOptions.paths["@abfc/runtime"]?.[0] ?? "", /^[A-Za-z]:\/.*runtime\/dist\/src\/index\.d\.ts$/);

    const runs = readFileSync(join(tmp, ".abfc", "runs.jsonl"), "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { step: string }).step);
    assert.deepEqual(runs, ["stubs.read", "stubs.reflect", "stubs.emit"]);

    // A second run rewrites everything, including the lock, under a different clock.
    const again = captureDeps(fake, () => fakeBackend(true, [], []));
    again.deps.cwd = tmp;
    again.deps.now = () => new Date(2027, 5, 6, 7, 8, 9);
    assert.equal(await main(["stubs"], again.deps), 0, again.text());
    const lock2 = JSON.parse(readFileSync(join(dir, "stubs.lock.json"), "utf8")) as { createdAt: string };
    assert.notEqual(lock2.createdAt, (lock as { createdAt: string }).createdAt);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc stubs: an explicit mod asset list reads only those assets; scriptModules warns ABFC3010", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, ["/TestMod/Items/BP_Hand"]);
    fake.files[join(tmp, "abf.config.json")] = JSON.stringify({
      mod: { name: "TestMod" },
      backend: { kind: "bp_apply", minProtocol: 1 },
      stubs: { classes: [], scriptClasses: [THING], modAssets: ["/TestMod/Items/BP_Hand"], scriptModules: ["/Script/Engine"] },
    });
    const reads: string[] = [];
    const cap = captureDeps(fake, () => fakeBackend(true, [], reads));
    cap.deps.cwd = tmp;
    const code = await main(["stubs"], cap.deps);
    assert.equal(code, 0, cap.text());
    assert.deepEqual(reads, ["/TestMod/Items/BP_Hand"]);
    assert.match(cap.text(), /warning ABFC3010/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc stubs: a backend without reflect is ABFC4011, exit 2, nothing written", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    const cap = captureDeps(fake, () => fakeBackend(false, [], []));
    cap.deps.cwd = tmp;
    const code = await main(["stubs"], cap.deps);
    assert.equal(code, 2, cap.text());
    assert.match(cap.text(), /error ABFC4011/);
    assert.equal(existsSync(join(tmp, ".abfc", "stubs")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("abfc stubs: stubs.widgetMembers are emitted on the class stub, recorded in the lock, and an unreflected widget class warns ABFC3011", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-cli-stubs-"));
  try {
    const fake = setup(tmp, []);
    const widgetMembers = { [THING]: { TitleText: "/Script/UMG.TextBlock" } };
    fake.files[join(tmp, "abf.config.json")] = JSON.stringify({
      mod: { name: "TestMod" },
      backend: { kind: "bp_apply", minProtocol: 1 },
      stubs: { classes: [], scriptClasses: [THING], modAssets: [], widgetMembers },
    });
    const cap = captureDeps(fake, () => fakeBackend(true, [], []));
    cap.deps.cwd = tmp;
    const code = await main(["stubs"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);
    assert.match(out, /warning ABFC3011: stubs\.widgetMembers: \/Script\/FakeEngine\.Thing TitleText is a \/Script\/UMG\.TextBlock, which is not in the stubs/);
    assert.match(out, /stubs\.scriptClasses/);

    const dir = join(tmp, ".abfc", "stubs", "ue5.4.4-1050002");
    const script = readFileSync(join(dir, "Script", "FakeEngine.d.ts"), "utf8");
    assert.match(script, /@bpPath \/Script\/FakeEngine\.Thing:TitleText/);
    assert.match(script, /@bpType object:\/Script\/UMG\.TextBlock/);
    assert.match(script, /@bpWidget/);
    assert.match(script, /readonly TitleText: UObject;/);
    const lock = JSON.parse(readFileSync(join(dir, "stubs.lock.json"), "utf8")) as { widgetMembers: unknown };
    assert.deepEqual(lock.widgetMembers, widgetMembers);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
