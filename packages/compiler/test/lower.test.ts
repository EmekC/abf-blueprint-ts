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

// ---- Phase 2: overrides, own calls, delegates, widgets, spawns, arithmetic, counted loops, array operations ----

const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const loaded2 = loadProgram(phase2Dir);

function lowerPhase2(name: string): IrModule {
  const sf = loaded2.files.classes.find((f) => f.fileName.endsWith(`/${name}`));
  assert.ok(sf, `${name} is a root file`);
  const hir = buildHir(loaded2, config, profile, [sf]);
  assert.deepEqual(hir.diagnostics, []);
  return lower(hir, profile);
}

/** Small query helpers over one unit. */
function kit(u: IrUnit) {
  return {
    node: (id: string): IrNode => {
      const n = u.nodes.find((x) => x.id === id);
      assert.ok(n, `node ${id}`);
      return n;
    },
    calls: (fn: string): IrNode[] => u.nodes.filter((n) => n.sem?.k === "call" && n.sem.function === fn),
    fns: (fn: string): IrNode[] => u.nodes.filter((n) => n.t3d.props.some((p) => p.includes(`MemberName="${fn}"`))),
    sets: (name: string): IrNode[] => u.nodes.filter((n) => n.sem?.k === "set" && n.sem.name === name),
    has: (from: string, to: string): boolean => u.wires.some((w) => w[0] === from && w[1] === to),
    into: (to: string): string[] => u.wires.filter((w) => w[1] === to).map((w) => w[0]),
  };
}

const directorIr = lowerPhase2("Director.ts");
const counterIr = lowerPhase2("Counter.ts");
const dUnit = (id: string): IrUnit => {
  const x = directorIr.assets[0]!.units.find((u) => u.id === id);
  assert.ok(x, `unit ${id}`);
  return x;
};
const cUnit = (id: string): IrUnit => {
  const x = counterIr.assets[0]!.units.find((u) => u.id === id);
  assert.ok(x, `unit ${id}`);
  return x;
};

test("phase 2 modules validate and keep unit ids and kinds", () => {
  assert.deepEqual(validateIrModule(directorIr), []);
  assert.deepEqual(validateIrModule(counterIr), []);
  assert.deepEqual(directorIr.assets[0]!.units.map((u) => [u.id, u.kind, u.graph]), [
    ["override:ReceiveTick", "override", "EventGraph"],
    ["event:Step", "event", "EventGraph"],
    ["event:Announce", "event", "EventGraph"],
    ["event:Start", "event", "EventGraph"],
    ["event:Scan", "event", "EventGraph"],
  ]);
  for (const u of [...directorIr.assets[0]!.units, ...counterIr.assets[0]!.units]) assert.equal(unitHash(u), u.hash);
});

test("a cross wire that names no unit or node is a validation problem", () => {
  const bad: IrModule = JSON.parse(JSON.stringify(directorIr));
  const start = bad.assets[0]!.units.find((u) => u.id === "event:Start")!;
  start.crossWires = [{ toUnit: "event:Nope", from: "ev0.OutputDelegate", to: "call0.Callback" }, { toUnit: "event:Scan", from: "zz9.OutputDelegate", to: "nope0.Callback" }];
  assert.equal(validateIrModule(bad).length, 3);
  assert.notEqual(unitHash(start), start.hash, "cross wires are part of the unit hash");
});

test("override entry and own call", () => {
  const u = dUnit("override:ReceiveTick");
  const k = kit(u);
  const entry = k.node("ev0");
  assert.deepEqual(entry.sem, { k: "override", class: "/Script/FakeEngine.Actor", function: "ReceiveTick" });
  assert.equal(entry.t3d.class, "/Script/BlueprintGraph.K2Node_Event");
  assert.ok(entry.t3d.props.some((p) => p.includes('MemberName="ReceiveTick"')));
  assert.deepEqual(u.signature.inputs, [{ name: "DeltaSeconds", type: "double" }]);
  const step = k.calls("Step");
  assert.equal(step.length, 1);
  assert.deepEqual(step[0]!.sem, { k: "call", function: "Step" });
  assert.deepEqual(step[0]!.t3d.props, ['FunctionReference=(MemberName="Step",bSelfContext=True)']);
  assert.ok(k.has("ev0.then", `${step[0]!.id}.execute`));
  assert.ok(k.has("ev0.DeltaSeconds", `${step[0]!.id}.Delta`));
});

test("arithmetic and comparisons pick the typed math functions", () => {
  const u = dUnit("event:Step");
  const k = kit(u);
  const sub = k.calls("Subtract_DoubleDouble");
  assert.equal(sub.length, 1);
  assert.ok(k.has("ev0.Delta", `${sub[0]!.id}.B`));
  const le = k.calls("LessEqual_DoubleDouble");
  assert.equal(le.length, 1);
  assert.deepEqual(le[0]!.pinDefaults, { B: "0.0" });
  assert.deepEqual(k.calls("Add_IntInt")[0]!.pinDefaults, { B: "1" });
  assert.deepEqual(k.calls("Multiply_DoubleDouble")[0]!.pinDefaults, { B: "2.0" });
  assert.deepEqual(k.calls("GreaterEqual_IntInt")[0]!.pinDefaults, { B: "3" });
  assert.deepEqual(k.calls("Greater_DoubleDouble")[0]!.pinDefaults, { B: "1.0" });
  const announce = k.calls("Announce")[0]!;
  assert.equal(k.into(`${announce.id}.N`).length, 1);
  assert.equal(k.into(`${announce.id}.Left`).length, 1);
  assert.equal(k.calls("Less_IntInt").length, 0);
  assert.equal(kit(dUnit("event:Announce")).calls("Less_IntInt").length, 1);
});

test("delegate argument becomes a cross wire; widgets, enum, class and name defaults", () => {
  const u = dUnit("event:Start");
  const k = kit(u);
  const timer = k.calls("SetTimerThing")[0]!;
  assert.deepEqual(u.crossWires, [{ toUnit: "event:Scan", from: "ev0.OutputDelegate", to: `${timer.id}.Callback` }]);
  assert.deepEqual(timer.pinDefaults, { Time: "1.0" });
  assert.equal(k.into(`${timer.id}.Callback`).length, 0, "no in-unit wire into the delegate pin");

  const cw = u.nodes.find((n) => n.sem?.k === "create_widget")!;
  assert.equal(cw.t3d.class, "/Script/UMGEditor.K2Node_CreateWidget");
  assert.deepEqual(cw.pinObjects, { Class: "/Game/Fake/WBP_Panel.WBP_Panel_C" });
  const owner = k.into(`${cw.id}.OwningPlayer`);
  assert.equal(owner.length, 1);
  assert.ok(u.nodes.some((n) => n.sem?.k === "get" && n.sem.name === "OwnerPC" && owner[0] === `${n.id}.OwnerPC`));

  const vis = k.calls("SetVisibility");
  assert.equal(vis.length, 2);
  for (const v of vis) assert.deepEqual(v.pinDefaults, { InVisibility: "Collapsed" });
  const all = k.calls("GetAllWidgets")[0]!;
  assert.deepEqual(all.pinObjects, { WidgetClass: "/Game/Fake/WBP_Panel.WBP_Panel_C" });
  assert.equal(all.pinDefaults?.TopLevelOnly, "true");
});

test("spawn node, transform defaults, name literal and indexing", () => {
  const u = dUnit("event:Scan");
  const k = kit(u);
  const sp = u.nodes.find((n) => n.sem?.k === "spawn")!;
  assert.equal(sp.t3d.class, "/Script/BlueprintGraph.K2Node_SpawnActorFromClass");
  assert.deepEqual(sp.pinObjects, { Class: "/Game/Fake/BP_FakePot.BP_FakePot_C" });
  assert.deepEqual(sp.pinDefaults, { CollisionHandlingOverride: "AlwaysSpawn" });
  const mk = k.calls("MakeTransform")[0]!;
  assert.deepEqual(mk.pinDefaults, { Location: "0, 0, 0", Rotation: "0, 0, 0", Scale: "1.000000,1.000000,1.000000" });
  assert.ok(k.has(`${mk.id}.ReturnValue`, `${sp.id}.SpawnTransform`));
  assert.equal(k.into(`${sp.id}.Owner`).length, 1);
  const destroy = k.calls("K2_DestroyActor");
  assert.ok(destroy.some((d) => k.has(`${sp.id}.ReturnValue`, `${d.id}.self`)));

  const label = k.sets("Label")[0]!;
  assert.deepEqual(label.pinDefaults, { Label: "Spawned" });

  const item = u.nodes.find((n) => n.t3d.class === profile.nodeClasses.getArrayItem)!;
  assert.deepEqual(item.pinTypes, { Array: "array:object:/Game/Fake/BP_FakePot.BP_FakePot_C", Output: "object:/Game/Fake/BP_FakePot.BP_FakePot_C" });
  assert.deepEqual(item.pinDefaults, { "Dimension 1": "0" });
});

test("this.X = c ? a : b: one branch, one set per side, both rejoin", () => {
  const u = cUnit("event:Pick");
  const k = kit(u);
  const elapsed = k.sets("Elapsed");
  assert.equal(elapsed.length, 2);
  const br = u.nodes.filter((n) => n.sem?.k === "branch");
  assert.equal(br.length, 3, "one branch for the first ternary, two for `a && b`");
  const first = br[0]!;
  assert.ok(k.has(`${first.id}.then`, `${elapsed[0]!.id}.execute`));
  assert.ok(k.has(`${first.id}.else`, `${elapsed[1]!.id}.execute`));
  const fast = u.nodes.find((n) => n.sem?.k === "get" && n.sem.name === "Fast")!;
  const slow = u.nodes.find((n) => n.sem?.k === "get" && n.sem.name === "Slow")!;
  assert.ok(k.has(`${fast.id}.Fast`, `${elapsed[0]!.id}.Elapsed`));
  assert.ok(k.has(`${slow.id}.Slow`, `${elapsed[1]!.id}.Elapsed`));
  const count = k.sets("Count");
  assert.deepEqual(count.map((c) => c.pinDefaults), [{ Count: "1" }, { Count: "0" }]);
  for (const c of count) assert.equal(u.wires.filter((w) => w[0] === `${c.id}.then`).length, 0);
  // both Elapsed sets lead to the first branch of the second ternary
  const second = br[1]!;
  assert.deepEqual(k.into(`${second.id}.execute`).sort(), elapsed.map((e) => `${e.id}.then`).sort());
});

test("counted for loops: counter variable, decrement, back-edge to the condition", () => {
  assert.deepEqual(counterIr.assets[0]!.variables.map((v) => [v.name, v.type, v.temp]), [
    ["abfc_Sweep_i0", "int", true],
    ["abfc_Sweep_i1", "int", true],
  ]);
  const u = cUnit("event:Sweep");
  const k = kit(u);

  // loop 0: for (let i = Pots.length - 1; i >= 0; i--)
  const [init0, dec0] = k.sets("abfc_Sweep_i0");
  assert.ok(init0 && dec0);
  assert.equal(init0.pinDefaults, undefined);
  const subs = k.calls("Subtract_IntInt");
  assert.equal(subs.length, 2);
  const startSub = subs.find((s) => k.has(`${s.id}.ReturnValue`, `${init0.id}.abfc_Sweep_i0`))!;
  assert.deepEqual(startSub.pinDefaults, { B: "1" });
  const head0 = u.wires.find((w) => w[0] === `${init0.id}.then`)![1].split(".")[0]!;
  assert.equal(u.nodes.find((n) => n.id === head0)!.sem?.k, "branch");
  const ge = k.calls("GreaterEqual_IntInt")[0]!;
  assert.deepEqual(ge.pinDefaults, { B: "0" });
  assert.ok(k.has(`${ge.id}.ReturnValue`, `${head0}.Condition`));
  assert.ok(k.has(`${dec0.id}.then`, `${head0}.execute`), "back-edge");
  const decSub = subs.find((s) => k.has(`${s.id}.ReturnValue`, `${dec0.id}.abfc_Sweep_i0`))!;
  assert.deepEqual(decSub.pinDefaults, { B: "1" });

  // loop 1: for (let j = 0; j < 3; j = j + 1)
  const [init1, inc1] = k.sets("abfc_Sweep_i1");
  assert.ok(init1 && inc1);
  assert.deepEqual(init1.pinDefaults, { abfc_Sweep_i1: "0" });
  const head1 = u.wires.find((w) => w[0] === `${init1.id}.then`)![1].split(".")[0]!;
  assert.ok(k.has(`${inc1.id}.then`, `${head1}.execute`), "back-edge");
  assert.deepEqual(k.calls("Less_IntInt")[0]!.pinDefaults, { B: "3" });
  assert.deepEqual(k.calls("Add_IntInt")[0]!.pinDefaults, { B: "1" });
  // loop 0 exits (head0.else) into loop 1's initializer
  assert.ok(k.has(`${head0}.else`, `${init1.id}.execute`));

  // the counter is read through the variable, also as the array index
  const item = u.nodes.find((n) => n.t3d.class === profile.nodeClasses.getArrayItem)!;
  const idx = k.into(`${item.id}.Dimension 1`);
  assert.equal(idx.length, 1);
  assert.ok(u.nodes.some((n) => n.sem?.k === "get" && n.sem.name === "abfc_Sweep_i0" && idx[0] === `${n.id}.abfc_Sweep_i0`));
});

test("array operations: Add, Remove, Clear, Find with pin types", () => {
  const u = cUnit("event:Sweep");
  const k = kit(u);
  const rm = k.fns("Array_Remove");
  assert.equal(rm.length, 2);
  assert.deepEqual(rm.map((n) => n.pinTypes), [
    { TargetArray: "array:object:/Game/Fake/BP_FakePot.BP_FakePot_C" },
    { TargetArray: "array:name" },
  ]);
  for (const r of rm) {
    assert.equal(r.t3d.class, profile.nodeClasses.callArrayFunction);
    assert.ok(!r.t3d.props.includes("bIsPureFunc=True"));
    assert.equal(k.into(`${r.id}.IndexToRemove`).length, 1);
    assert.equal(k.into(`${r.id}.TargetArray`).length, 1);
  }
  const add = k.fns("Array_Add");
  assert.equal(add.length, 1);
  assert.deepEqual(add[0]!.pinTypes, { TargetArray: "array:name", NewItem: "name" });
  assert.deepEqual(add[0]!.pinDefaults, { NewItem: "Slot" });
  const find = k.fns("Array_Find");
  assert.equal(find.length, 1);
  assert.ok(find[0]!.t3d.props.includes("bIsPureFunc=True"));
  assert.deepEqual(find[0]!.pinTypes, { TargetArray: "array:name", ItemToFind: "name" });
  assert.deepEqual(find[0]!.pinDefaults, { ItemToFind: "Slot" });
  const eq = k.calls("EqualEqual_IntInt")[0]!;
  assert.ok(k.has(`${find[0]!.id}.ReturnValue`, `${eq.id}.A`));
  assert.deepEqual(eq.pinDefaults, { B: "-1" });
  const clear = k.fns("Array_Clear");
  assert.equal(clear.length, 1);
  assert.deepEqual(clear[0]!.pinTypes, { TargetArray: "array:name" });
  assert.ok(u.wires.some((w) => w[1] === `${clear[0]!.id}.execute`));
});

// ---- Phase 3: FormatText and MakeStruct ----

const phase3Dir = fileURLToPath(new URL("../../test/fixtures/phase3", import.meta.url));

function lowerWidget(): IrModule {
  const loaded = loadProgram(phase3Dir);
  const widget = loaded.files.classes.find((f) => f.fileName.endsWith("/Widget.ts"));
  assert.ok(widget);
  const hir = buildHir(loaded, config, profile, [widget]);
  assert.deepEqual(hir.diagnostics, []);
  return lower(hir, profile);
}

const widgetIr = lowerWidget();
const widgetUnit = (id: string): IrUnit => {
  const u = widgetIr.assets[0]!.units.find((x) => x.id === id);
  assert.ok(u, `unit ${id}`);
  return u;
};

test("a template literal typed text lowers to FormatText: arg names, Format default, typed arg pin, Result output", () => {
  assert.deepEqual(validateIrModule(widgetIr), []);
  const u = widgetUnit("event:Join");
  const fmt = u.nodes.filter((n) => n.t3d.class === profile.nodeClasses.formatText);
  assert.equal(fmt.length, 1);
  const f = fmt[0]!;
  assert.deepEqual(f.t3d.props, ['PinNames(0)="name"']);
  assert.deepEqual(f.pinDefaults, { Format: "+ {name}" });
  assert.deepEqual(f.pinTypes, { name: "text" });
  const entry = u.nodes.find((n) => n.sem?.k === "event")!;
  const nameOut = u.wires.find((w) => w[1] === `${f.id}.name`);
  assert.ok(nameOut, "the text parameter feeds the arg pin");
  assert.equal(nameOut[0], `${entry.id}.name`);
  const setText = u.nodes.find((n) => n.sem?.k === "call" && n.sem.function === "SetText")!;
  assert.ok(u.wires.some((w) => w[0] === `${f.id}.Result` && w[1] === `${setText.id}.InText`));
});

test("FormatText escapes braces and names duplicate substitutions with a suffix", () => {
  const u = widgetUnit("event:Tag");
  const f = u.nodes.find((n) => n.t3d.class === profile.nodeClasses.formatText)!;
  assert.deepEqual(f.t3d.props, ['PinNames(0)="name"', 'PinNames(1)="hint"', 'PinNames(2)="hint_2"']);
  assert.equal(f.pinDefaults!.Format, "+ {name} `{{hint}`} {hint_2}");
  assert.deepEqual(f.pinTypes, { name: "text", hint: "text", hint_2: "text" });
});

test("quotes, backslashes and newlines in a FormatText template or a text literal are escaped for T3D", () => {
  assert.deepEqual(validateIrModule(widgetIr), []);
  const u = widgetUnit("event:Quote");
  const f = u.nodes.find((n) => n.t3d.class === profile.nodeClasses.formatText)!;
  // TS source: `say "${name}" \\ then<LF>done` -> cooked text: say "{name}" \ then<LF>done
  assert.equal(f.pinDefaults!.Format, 'say \\"{name}\\" \\\\ then\\ndone');
  const lit = u.nodes.find((n) => n.sem?.k === "call" && n.sem.function === "SetText" && n.pinDefaults?.InText !== undefined)!;
  assert.equal(lit.pinDefaults!.InText, 'He said \\"hi\\"');
  // plain text is untouched
  assert.deepEqual(widgetUnit("event:Join").nodes.find((n) => n.t3d.class === profile.nodeClasses.formatText)!.pinDefaults, { Format: "+ {name}" });
});

test("an object literal of a stub struct lowers to MakeStruct with one field pin per property and the struct output", () => {
  const u = widgetUnit("event:Style");
  const mk = u.nodes.filter((n) => n.t3d.class === profile.nodeClasses.makeStruct);
  assert.equal(mk.length, 1);
  const m = mk[0]!;
  assert.deepEqual(m.t3d.props, ["bMadeAfterOverridePinRemoval=True", 'StructType="/Script/CoreUObject.ScriptStruct\'/Script/TestCore.ExampleFont\'"']);
  const entry = u.nodes.find((n) => n.sem?.k === "event")!;
  assert.ok(has2(u, `${entry.id}.size`, `${m.id}.Size`));
  assert.ok(has2(u, `${entry.id}.family`, `${m.id}.Family`));
  assert.ok(has2(u, `${entry.id}.label`, `${m.id}.Label`), "the shorthand property reads the local, which is the parameter");
  assert.equal(wiresIntoOf(u, m.id).length, 3);
  const setFont = u.nodes.find((n) => n.sem?.k === "call" && n.sem.function === "SetFont")!;
  assert.ok(u.wires.some((w) => w[0] === `${m.id}.ExampleFont` && w[1] === `${setFont.id}.InFontInfo`));
});

function has2(u: IrUnit, from: string, to: string): boolean {
  return u.wires.some((w) => w[0] === from && w[1] === to);
}

function wiresIntoOf(u: IrUnit, to: string): string[] {
  return u.wires.filter((w) => w[1].startsWith(`${to}.`)).map((w) => w[0]);
}
