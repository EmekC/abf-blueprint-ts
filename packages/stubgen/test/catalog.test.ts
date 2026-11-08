import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbfcError } from "@abfc/env";
import { CATALOG_FILE, catalogFromBackend, catalogLookup, completionNamesOf, readCatalog, writeCatalog } from "../src/index.js";

const RAW = {
  version: 1,
  engineVersion: "5.4.4-fake",
  game: [
    { path: "/Game/Fake/BP_Fake.BP_Fake_C", kind: "Blueprint", parent: "/Script/FakeEngine.Thing", interface: false },
    { path: "/Game/Fake/BP_Other.BP_Other_C", kind: "Widget", parent: null, interface: true },
    { path: "/Script/Wrong.Row", kind: "Blueprint" },
    { kind: "Blueprint" },
    "junk",
  ],
  scriptClasses: [
    { path: "/Script/FakeEngine.Thing", parent: "/Script/CoreUObject.Object" },
    { path: "/Script/CoreUObject.Object", parent: null },
    { path: "/Script/FakeEngine.default", parent: "/Script/FakeEngine.Thing" },
    { path: "/Script/FakeEngine.FakeLibrary", parent: "/Script/Engine.BlueprintFunctionLibrary", library: true, functions: ["DoFake", "Bad Name", "K2_Other", 7] },
    { path: "/Game/Wrong.Row" },
  ],
  scriptStructs: ["/Script/FakeEngine.FThing", 3, "/Game/Nope"],
  scriptEnums: ["/Script/FakeEngine.EFake"],
};

const catalog = () => catalogFromBackend(RAW, "fp-1", "2026-01-02T00:00:00.000Z");

test("catalogFromBackend keeps valid rows and drops malformed ones", () => {
  const c = catalog();
  assert.equal(c.editorFingerprint, "fp-1");
  assert.equal(c.engineVersion, "5.4.4-fake");
  assert.deepEqual(c.game.map((g) => g.path), ["/Game/Fake/BP_Fake.BP_Fake_C", "/Game/Fake/BP_Other.BP_Other_C"]);
  assert.equal(c.game[1]?.interface, true);
  assert.deepEqual(c.scriptClasses.map((s) => s.path), ["/Script/FakeEngine.Thing", "/Script/CoreUObject.Object", "/Script/FakeEngine.default", "/Script/FakeEngine.FakeLibrary"]);
  assert.deepEqual(c.scriptClasses[3]?.functions, ["DoFake", "Bad Name", "K2_Other"]);
  assert.deepEqual(c.scriptStructs, ["/Script/FakeEngine.FThing"]);
  assert.deepEqual(c.scriptEnums, ["/Script/FakeEngine.EFake"]);
});

test("a wrong version or missing arrays throw ABFC4002", () => {
  for (const bad of [null, [], { version: 2, game: [], scriptClasses: [], scriptStructs: [], scriptEnums: [] }, { version: 1, game: [], scriptClasses: [], scriptStructs: [] }]) {
    assert.throws(() => catalogFromBackend(bad, "fp", "t"), (e: unknown) => e instanceof AbfcError && e.diagnostic.code === "ABFC4002" && /unknown format/.test(e.diagnostic.message));
  }
});

test("write and read round trip with a stable sha256", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-catalog-"));
  try {
    assert.equal(readCatalog(dir), null);
    const sha = writeCatalog(dir, catalog());
    const back = readCatalog(dir);
    assert.equal(back?.sha256, sha);
    assert.deepEqual(back?.catalog, catalog());
    writeFileSync(join(dir, CATALOG_FILE), "{broken", "utf8");
    assert.equal(readCatalog(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogLookup: kinds, /Script and /Game import resolution, reserved word and UObject", () => {
  const l = catalogLookup(catalog());
  assert.equal(l.kindOf("/Game/Fake/BP_Fake.BP_Fake_C"), "game");
  assert.equal(l.kindOf("/Script/FakeEngine.Thing"), "class");
  assert.equal(l.kindOf("/Script/FakeEngine.FThing"), "struct");
  assert.equal(l.kindOf("/Script/FakeEngine.EFake"), "enum");
  assert.equal(l.kindOf("/Script/FakeEngine.Nope"), undefined);
  assert.equal(l.resolveImport("/Script/FakeEngine", "Thing"), "/Script/FakeEngine.Thing");
  assert.equal(l.resolveImport("/Script/FakeEngine", "FThing"), "/Script/FakeEngine.FThing");
  assert.equal(l.resolveImport("/Script/FakeEngine", "EFake"), "/Script/FakeEngine.EFake");
  assert.equal(l.resolveImport("/Script/FakeEngine", "default_"), "/Script/FakeEngine.default");
  assert.equal(l.resolveImport("/Script/CoreUObject", "UObject"), "/Script/CoreUObject.Object");
  assert.equal(l.resolveImport("/Script/FakeEngine", "Missing"), undefined);
  assert.equal(l.resolveImport("/Game/Fake/BP_Fake", "BP_Fake_C"), "/Game/Fake/BP_Fake.BP_Fake_C");
  assert.equal(l.resolveImport("/Game/Fake/BP_Fake", "Other"), undefined);
  assert.equal(l.resolveImport("/Mod/X", "X"), undefined);
  assert.deepEqual(l.gameClassesOf("/Game/Fake/BP_Other"), ["/Game/Fake/BP_Other.BP_Other_C"]);
  assert.deepEqual(l.gameClassesOf("/Game/Fake/Nope"), []);
});

test("catalogLookup.resolveAdd: known path, TS name form, /Game module, unknown", () => {
  const l = catalogLookup(catalog());
  assert.deepEqual(l.resolveAdd("/Script/FakeEngine.Thing"), ["/Script/FakeEngine.Thing"]);
  assert.deepEqual(l.resolveAdd("/Script/FakeEngine.default_"), ["/Script/FakeEngine.default"]);
  assert.deepEqual(l.resolveAdd("/Game/Fake/BP_Fake"), ["/Game/Fake/BP_Fake.BP_Fake_C"]);
  assert.deepEqual(l.resolveAdd("/Game/Fake/BP_Fake.BP_Fake_C"), ["/Game/Fake/BP_Fake.BP_Fake_C"]);
  assert.deepEqual(l.resolveAdd("/Script/FakeEngine.Nope"), []);
  assert.deepEqual(l.resolveAdd("/Game/Fake/Nope.Nope_C"), []);
  assert.deepEqual(l.resolveAdd("garbage"), []);
});

test("completionNamesOf: types of every kind, library functions with container and module, sorted", () => {
  const n = completionNamesOf(catalog());
  const types = n.types.map((t) => `${t.kind}:${t.name}@${t.module}`);
  assert.ok(types.includes("class:BP_Fake_C@/Game/Fake/BP_Fake"));
  assert.ok(types.includes("class:UObject@/Script/CoreUObject"));
  assert.ok(types.includes("class:default_@/Script/FakeEngine"));
  assert.ok(types.includes("struct:FThing@/Script/FakeEngine"));
  assert.ok(types.includes("enum:EFake@/Script/FakeEngine"));
  assert.deepEqual(n.types.map((t) => t.name), [...n.types.map((t) => t.name)].sort());
  assert.deepEqual(n.functions, [
    { name: "DoFake", container: "FakeLibrary", module: "/Script/FakeEngine" },
    { name: "K2_Other", container: "FakeLibrary", module: "/Script/FakeEngine" },
  ]);
});
