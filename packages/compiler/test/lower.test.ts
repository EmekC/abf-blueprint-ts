import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unitHash, validateIrModule } from "@abfc/ir";
import type { IrModule, IrNode, IrUnit, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/project and packages/env/profiles
const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

function lowerProject(dir: string): IrModule {
  const loaded = loadProgram(dir);
  const relay = loaded.files.classes.find((f) => f.fileName.endsWith("/Relay.ts"));
  assert.ok(relay);
  const hir = buildHir(loaded, config, profile, [relay]);
  assert.deepEqual(hir.diagnostics, []);
  return lower(hir, profile);
}

const ir = lowerProject(projectDir);
const unit: IrUnit = ir.assets[0]!.units[0]!;
const node = (id: string): IrNode => {
  const n = unit.nodes.find((x) => x.id === id);
  assert.ok(n, `node ${id}`);
  return n;
};
const has = (from: string, to: string): boolean => unit.wires.some((w) => w[0] === from && w[1] === to);
const calls = (fn: string): IrNode[] => unit.nodes.filter((n) => n.sem?.k === "call" && n.sem.function === fn);
const wiresInto = (to: string): string[] => unit.wires.filter((w) => w[1] === to).map((w) => w[0]);

test("module shape and validation", () => {
  assert.deepEqual(validateIrModule(ir), []);
  assert.equal(ir.irVersion, 1);
  assert.equal(ir.profile, profile.id);
  assert.equal(ir.mod, "TestMod");
  assert.equal(ir.assets.length, 1);
  assert.equal(ir.assets[0]!.path, "/TestMod/Relay/BP_Relay");
  assert.equal(ir.classMeta["/Game/Fake/WBP_Show.WBP_Show_C"], "/Script/UMG.WidgetBlueprintGeneratedClass");
  assert.equal(unit.id, "event:UpdateTarget");
  assert.equal(unit.graph, "EventGraph");
  assert.deepEqual(unit.locals, []);
  assert.match(unit.hash, /^sha256:[0-9a-f]{64}$/);
});

test("exactly two temps", () => {
  const vars = ir.assets[0]!.variables;
  assert.deepEqual(vars.map((v) => [v.name, v.type, v.temp, v.flags]), [
    ["abfc_UpdateTarget_t0", "name", true, ["transient"]],
    ["abfc_UpdateTarget_i0", "int", true, ["transient"]],
  ]);
});

test("pin types: casts, array length, array item", () => {
  const casts = unit.nodes.filter((n) => n.sem?.k === "cast");
  assert.equal(casts.length, 2);
  for (const c of casts) assert.deepEqual(c.pinTypes, { Object: profile.castObjectPinType });
  const lengths = unit.nodes.filter((n) => n.t3d.class === profile.nodeClasses.callArrayFunction);
  assert.deepEqual(lengths.map((n) => n.pinTypes), [
    { TargetArray: "array:struct:/Script/FakeGame.FakeTag" },
    { TargetArray: "array:object:/Game/Fake/WBP_Show.WBP_Show_C" },
  ]);
  const items = unit.nodes.filter((n) => n.t3d.class === profile.nodeClasses.getArrayItem);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.pinTypes, {
    Array: "array:object:/Game/Fake/WBP_Show.WBP_Show_C",
    Output: "object:/Game/Fake/WBP_Show.WBP_Show_C",
  });
});

test("exec wiring of the early exits and the loop", () => {
  const entry = unit.nodes.find((n) => n.sem?.k === "event")!;
  assert.deepEqual(entry.sem, { k: "event", name: "UpdateTarget" });
  // entry -> owner valid branch
  const firstBranch = unit.wires.find((w) => w[0] === `${entry.id}.then`)![1];
  assert.match(firstBranch, /^br\d+\.execute$/);
  const validBranch = firstBranch.split(".")[0]!;
  assert.ok(wiresInto(`${validBranch}.Condition`).some((s) => s.startsWith(calls("IsValid")[0]!.id + ".")));

  // the first HideAll receives both cast fail exits (and the two invalid branch exits)
  const casts = unit.nodes.filter((n) => n.sem?.k === "cast");
  const hide = calls("HideAll");
  assert.equal(hide.length, 3);
  const sources = wiresInto(`${hide[0]!.id}.execute`);
  for (const c of casts) assert.ok(sources.includes(`${c.id}.CastFailed`), `${c.id}.CastFailed -> first HideAll`);
  assert.ok(sources.includes(`${validBranch}.else`));
  assert.equal(sources.length, 4);

  // both early-compare else exits go to the LastTarget set
  const sets = unit.nodes.filter((n) => n.sem?.k === "set" && n.sem.name === "LastTarget");
  assert.equal(sets.length, 2);
  const into = wiresInto(`${sets[1]!.id}.execute`);
  assert.equal(into.length, 2);
  assert.ok(into.every((s) => s.endsWith(".else")));

  // NotValid of the exec result goes into a HideAll
  const getRow = calls("GetRow")[0]!;
  assert.ok(hide.some((h) => has(`${getRow.id}.NotValid`, `${h.id}.execute`)));

  // loop: back-edge and exit
  const counter = "abfc_UpdateTarget_i0";
  const incSet = unit.nodes.filter((n) => n.sem?.k === "set" && n.sem.name === counter);
  assert.equal(incSet.length, 2);
  assert.equal(incSet[0]!.pinDefaults?.[counter], "0");
  const head = unit.wires.find((w) => w[0] === `${incSet[0]!.id}.then`)![1].split(".")[0]!;
  assert.ok(has(`${incSet[1]!.id}.then`, `${head}.execute`), "back-edge into the loop head");
  const visible = unit.nodes.find((n) => n.sem?.k === "set" && n.sem.name === "Visible")!;
  assert.equal(visible.pinDefaults?.Visible, "true");
  assert.ok(has(`${head}.else`, `${visible.id}.execute`));
});

test("literal defaults on the compares", () => {
  const reals = calls("EqualEqual_DoubleDouble");
  assert.equal(reals.length, 2);
  for (const r of reals) assert.deepEqual(r.pinDefaults, { B: "0.0" });
  assert.deepEqual(calls("EqualEqual_IntInt")[0]!.pinDefaults, { B: "0" });
  assert.deepEqual(calls("Show")[0]!.pinDefaults, { Flag: "true" });
});

test("positions are non-negative and exec nodes flow left to right", () => {
  for (const n of unit.nodes) assert.ok(n.pos[0] >= 0 && n.pos[1] >= 0, n.id);
  assert.ok(node("ev0").pos[0] <= node("br0").pos[0]);
  assert.ok(node("get0").pos[0] < node("br0").pos[0] || node("get0").pos[0] === 0);
  assert.equal(new Set(unit.nodes.map((n) => n.pos.join(","))).size, unit.nodes.length);
});

test("unitHash: stable across lowerings, ignores positions, changes with a literal", () => {
  assert.equal(unitHash(unit), unit.hash);
  assert.equal(lowerProject(projectDir).assets[0]!.units[0]!.hash, unit.hash);

  // inside the package tree so that `@abfc/runtime` still resolves through the workspace node_modules
  const dir = mkdtempSync(join(fileURLToPath(new URL("./", import.meta.url)), "lower-"));
  try {
    cpSync(projectDir, dir, { recursive: true });
    const file = join(dir, "src", "Relay.ts");
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("info.A === 0"));
    writeFileSync(file, text.replace("info.A === 0", "info.A === 1"));
    const edited = lowerProject(dir).assets[0]!.units[0]!;
    assert.notEqual(edited.hash, unit.hash);
    const real = edited.nodes.filter((n) => n.sem?.k === "call" && n.sem.function === "EqualEqual_DoubleDouble");
    assert.deepEqual(real.map((n) => n.pinDefaults?.B), ["1.0", "0.0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Relay fixture keeps its lowered size: 52 nodes, 74 wires", () => {
  assert.equal(unit.nodes.length, 52);
  assert.equal(unit.wires.length, 74);
});

/** Lowers a one-event Relay whose body is `body`, in a copy of the fixture project; returns the unit. */
function lowerBody(body: string): IrUnit {
  // inside the package tree so that `@abfc/runtime` still resolves through the workspace node_modules
  const dir = mkdtempSync(join(fileURLToPath(new URL("./", import.meta.url)), "lower-"));
  try {
    cpSync(projectDir, dir, { recursive: true });
    const file = join(dir, "src", "Relay.ts");
    const text = readFileSync(file, "utf8");
    const start = text.indexOf("  @event");
    assert.ok(start > 0);
    writeFileSync(file, `${text.slice(0, start)}  @event\n  UpdateTarget(): void {\n${body}\n  }\n}\n`);
    return lowerProject(dir).assets[0]!.units[0]!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const isValidCount = (u: IrUnit): number => u.nodes.filter((n) => n.sem?.k === "call" && n.sem.function === "IsValid").length;

test("cast guard: a failed cast that rejoins is checked again, one that exits is not", () => {
  const cast = "    const pot = cast(this.OwnerPC?.GetPawnThing(), BP_FakePot_C);\n";
  // the owner chain contributes one IsValid in every variant
  const exitEarly = lowerBody(`${cast}    if (!pot) return;\n    pot?.Ready;`);
  assert.equal(isValidCount(exitEarly), 1);
  const exitInOr = lowerBody(`${cast}    if (!pot || !pot.Ready) {\n      this.HideAll();\n      return;\n    }\n    pot?.Ready;`);
  assert.equal(isValidCount(exitInOr), 1);
  const rejoin = lowerBody(`${cast}    if (pot) {\n      this.HideAll();\n    }\n    pot?.Ready;`);
  assert.equal(isValidCount(rejoin), 2);
  const rejoinNot = lowerBody(`${cast}    if (!pot) {\n      this.HideAll();\n    }\n    pot?.Ready;`);
  assert.equal(isValidCount(rejoinNot), 2);
  // a second `if (pot)` after one that rejoined does not trust the cast either
  const twice = lowerBody(`${cast}    if (pot) {\n      this.HideAll();\n    }\n    if (pot) {\n      this.HideAll();\n    }`);
  assert.equal(isValidCount(twice), 2);
  // two optional uses in a row: the first consumes the cast failure, the second checks validity
  const chained = lowerBody(`${cast}    pot?.Ready;\n    pot?.Ready;`);
  assert.equal(isValidCount(chained), 2);
});

test("cast guard: a branch mixing the failed cast with other exits still checks validity", () => {
  const cast = "    const pot = cast(this.OwnerPC?.GetPawnThing(), BP_FakePot_C);\n";
  // else is entered from the failed cast and from the false `b`: `pot` may be null there
  const mixedElse = lowerBody(`${cast}    if (pot && this.OwnerPC) {\n      this.HideAll();\n    } else {\n      pot?.Ready;\n    }`);
  assert.equal(isValidCount(mixedElse), 3);
  const mixedThen = lowerBody(`${cast}    if (!pot || this.OwnerPC) {\n      pot?.Ready;\n    }`);
  assert.equal(isValidCount(mixedThen), 3);
});
