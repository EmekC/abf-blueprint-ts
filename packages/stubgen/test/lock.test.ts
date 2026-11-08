import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "@abfc/env";
import type { Environment, ProjectConfig } from "@abfc/env";
import { checkLock, emitManual, manualFromExport, newLock, readLock, sortedWidgetMembers, writeLock, writeTsconfigPaths } from "../src/index.js";
import type { StubsLock } from "../src/index.js";

const profile = loadProfile();

function lock(over: Partial<StubsLock> = {}): StubsLock {
  return newLock({
    profile: profile.id,
    engineVersion: "5.4.4-fake",
    modEditorVersion: profile.modEditorVersion,
    editorFingerprint: "fp-1",
    filterContentVersion: "v1",
    classes: ["/Game/Fake/BP_Fake.BP_Fake_C"],
    scriptClasses: ["/Script/FakeEngine.Thing"],
    modAssets: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

const config = { stubs: { classes: ["/Game/Fake/BP_Fake.BP_Fake_C"], scriptClasses: ["/Script/FakeEngine.Thing"], modAssets: [] } } as unknown as ProjectConfig;

function env(over: { appVersion?: string | null; fingerprint?: string | null } = {}): Environment {
  return {
    profile,
    appVersion: over.appVersion === undefined ? `++UE5+Release-5.4-CL-${profile.buildTag}` : over.appVersion,
    fingerprint: over.fingerprint === undefined ? "fp-1" : over.fingerprint,
  } as unknown as Environment;
}

test("lock round trip through a folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-lock-"));
  try {
    const stubs = join(dir, "stubs", "p1");
    assert.equal(readLock(stubs), null);
    const l = lock();
    writeLock(stubs, l);
    assert.deepEqual(readLock(stubs), l);
    assert.equal(l.generator, "0.5.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkLock: missing lock is ABFC3003", () => {
  const d = checkLock(null, env(), config, "build");
  assert.deepEqual(d.map((x) => [x.code, x.severity]), [["ABFC3003", "error"]]);
});

test("checkLock: stubs from another generator version are a warning (ABFC3001) that names abfc stubs, in check and build mode", () => {
  for (const mode of ["check", "build"] as const) {
    const d = checkLock(lock({ generator: "0.0.1" }), env(), config, mode);
    assert.equal(d.length, 1);
    assert.equal(d[0]!.code, "ABFC3001");
    assert.equal(d[0]!.severity, "warning");
    assert.match(d[0]!.message, /abfc stubs 0.0.1/);
    assert.match(d[0]!.message, /Run "abfc stubs"/);
  }
});

test("checkLock: matching lock is clean", () => {
  assert.deepEqual(checkLock(lock(), env(), config, "build"), []);
});

test("checkLock: fingerprint change is ABFC3001, error in build and warning in check", () => {
  const e = env({ fingerprint: "fp-2" });
  const build = checkLock(lock(), e, config, "build");
  assert.deepEqual(build.map((x) => [x.code, x.severity]), [["ABFC3001", "error"]]);
  assert.match(build[0]?.message ?? "", /Run "abfc stubs" to regenerate/);
  const check = checkLock(lock(), e, config, "check");
  assert.deepEqual(check.map((x) => [x.code, x.severity]), [["ABFC3001", "warning"]]);
});

test("checkLock: unknown editor build and profile mismatch are ABFC3002", () => {
  const unknownBuild = checkLock(lock(), env({ appVersion: "9.9.9-unknown" }), config, "build");
  assert.equal(unknownBuild[0]?.code, "ABFC3002");
  const other = checkLock(lock({ profile: "other-profile" }), env(), config, "build");
  assert.equal(other[0]?.code, "ABFC3002");
});

test("checkLock: configured classes missing from the lock warn", () => {
  const d = checkLock(lock({ scriptClasses: [] }), env(), config, "build");
  assert.deepEqual(d.map((x) => [x.code, x.severity]), [["ABFC3003", "warning"]]);
  assert.match(d[0]?.message ?? "", /FakeEngine\.Thing/);
});

test("checkLock: a changed stubs.widgetMembers is ABFC3003, key order does not matter", () => {
  const members = { "/Game/UI/W_Hud.W_Hud_C": { Title: "/Script/UMG.TextBlock", Body: "/Script/UMG.TextBlock" } };
  const withMembers = (m: Record<string, Record<string, string>>): ProjectConfig =>
    ({ stubs: { ...config.stubs, widgetMembers: m } }) as unknown as ProjectConfig;
  // lock without widgetMembers (old stubs) vs a configured member
  const added = checkLock(lock(), env(), withMembers(members), "build");
  assert.deepEqual(added.map((x) => [x.code, x.severity]), [["ABFC3003", "warning"]]);
  assert.match(added[0]?.message ?? "", /widgetMembers/);
  // the same members in another key order are equal
  const l = lock({ widgetMembers: sortedWidgetMembers(members) });
  assert.deepEqual(checkLock(l, env(), withMembers({ "/Game/UI/W_Hud.W_Hud_C": { Body: "/Script/UMG.TextBlock", Title: "/Script/UMG.TextBlock" } }), "build"), []);
  // a changed widget class and a removed member both warn
  const changed = checkLock(l, env(), withMembers({ "/Game/UI/W_Hud.W_Hud_C": { Title: "/Script/UMG.RichTextBlock", Body: "/Script/UMG.TextBlock" } }), "build");
  assert.deepEqual(changed.map((x) => x.code), ["ABFC3003"]);
  const removed = checkLock(l, env(), withMembers({}), "check");
  assert.deepEqual(removed.map((x) => [x.code, x.severity]), [["ABFC3003", "warning"]]);
});

test("writeTsconfigPaths writes forward-slash absolute paths and the stub patterns", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-paths-"));
  try {
    const file = writeTsconfigPaths(join(dir, ".abfc"), "p1", "TestMod", "C:\\fake\\runtime\\dist\\src\\index.d.ts", "C:\\fake\\testkit\\dist\\src\\index.d.ts");
    const doc = JSON.parse(readFileSync(file, "utf8")) as { compilerOptions: { paths: Record<string, string[]> } };
    const paths = doc.compilerOptions.paths;
    assert.deepEqual(paths["/Script/*"], ["./stubs/p1/Script/*.js"]);
    assert.deepEqual(paths["/Game/*"], ["./stubs/p1/Game/*.js"]);
    assert.deepEqual(paths["/TestMod/*"], ["./stubs/p1/Mod/TestMod/*.js"]);
    assert.deepEqual(paths["@mod/*"], ["./stubs/p1/Mod/TestMod/*.js"]);
    assert.deepEqual(paths["@abfc/runtime"], ["C:/fake/runtime/dist/src/index.d.ts"]);
    assert.deepEqual(paths["@abfc/testkit"], ["C:/fake/testkit/dist/src/index.d.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeTsconfigPaths maps @abfc/ir only when irDts is given, otherwise the output is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-paths-"));
  try {
    const rt = "C:\\fake\\runtime\\index.d.ts";
    const tk = "C:\\fake\\testkit\\index.d.ts";
    const without = readFileSync(writeTsconfigPaths(join(dir, "a"), "p1", "TestMod", rt, tk), "utf8");
    const explicitUndefined = readFileSync(writeTsconfigPaths(join(dir, "b"), "p1", "TestMod", rt, tk, undefined), "utf8");
    assert.equal(explicitUndefined, without);
    assert.equal(JSON.parse(without).compilerOptions.paths["@abfc/ir"], undefined);
    assert.ok(!without.includes("@abfc/ir"));
    const withIr = JSON.parse(readFileSync(writeTsconfigPaths(join(dir, "c"), "p1", "TestMod", rt, tk, "C:\\fake\\ir\\index.d.ts"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    assert.deepEqual(withIr.compilerOptions.paths["@abfc/ir"], ["C:/fake/ir/index.d.ts"]);
    assert.deepEqual(Object.keys(withIr.compilerOptions.paths).slice(-2), ["@abfc/testkit", "@abfc/ir"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const EXPORT = [
  "Begin Object Class=/Script/Engine.Blueprint Name=\"BP_Hand\" ExportPath=\"/Script/Engine.Blueprint'/TestMod/BP_Hand.BP_Hand'\"",
  "   ParentClass=\"/Script/CoreUObject.Class'/Script/FakeEngine.Thing'\"",
  "   NewVariables(0)=(VarName=\"Hp\",VarType=(PinCategory=\"int\",PinSubCategory=\"\",PinSubCategoryObject=None,ContainerType=None),DefaultValue=\"0\")",
  "   NewVariables(1)=(VarName=\"abfc_Mine\",VarType=(PinCategory=\"int\",PinSubCategory=\"\",PinSubCategoryObject=None,ContainerType=None),DefaultValue=\"0\")",
  "End Object",
].join("\n");

test("manual stubs leave out owned members and mark the rest hand-made", () => {
  const m = manualFromExport(
    "/TestMod/BP_Hand",
    EXPORT,
    { blueprint: { class: "Blueprint" }, functions: [{ name: "Heal", inputs: [{ name: "Amount", type: "int" }], outputs: [] }] },
    { units: ["function:Heal"], variables: ["abfc_Mine"] },
  );
  assert.equal(m.meta, "/Script/Engine.BlueprintGeneratedClass");
  assert.equal(m.parent, "/Script/FakeEngine.Thing");
  assert.deepEqual(m.variables.map((v) => v.name), ["Hp", "abfc_Mine"]);
  const f = emitManual(m);
  assert.equal(f.file, "Mod/TestMod/BP_Hand.d.ts");
  assert.match(f.text, /^ {2}Hp: int;$/m);
  assert.doesNotMatch(f.text, /abfc_Mine/);
  assert.doesNotMatch(f.text, /Heal/);
  assert.match(f.text, /@bpHandMade/);
  assert.match(f.text, /export declare class BP_Hand_C extends Thing \{\}/);
});

test("a lock with auto round-trips; a missing lock says abfc build also generates stubs", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-lock-auto-"));
  try {
    const auto = { catalogSha256: "abc", gameClasses: 3, failed: ["/Game/Fake/BP_Bad.BP_Bad_C"], added: ["/Script/FakeEngine.Other"] };
    const l = lock({ auto });
    writeLock(join(dir, "p1"), l);
    assert.deepEqual(readLock(join(dir, "p1"))?.auto, auto);
    assert.equal(readLock(join(dir, "p1"))?.createdAt, l.createdAt);
    assert.equal(lock().auto, undefined);
    const missing = checkLock(null, env(), config, "build");
    assert.equal(missing[0]?.code, "ABFC3003");
    assert.equal(missing[0]?.fix, 'run "abfc stubs" (abfc build also generates them).');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
