import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Diagnostic, Profile } from "@abfc/ir";
import { buildHir, checkSubset, compileTests, loadProgram } from "../src/index.js";
import type { HirExpr, HirStmt } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/project
const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profile = { id: "test" } as unknown as Profile;
const config = { mod: "TestMod" };

const loaded = loadProgram(projectDir);
const fileOf = (name: string) => {
  const sf = loaded.files.classes.find((f) => f.fileName.endsWith(`/${name}`));
  assert.ok(sf, `${name} is a root file`);
  return sf;
};
const inFile = (ds: Diagnostic[], file: string) => ds.filter((d) => d.span?.file === file);

test("project loads: class files and test files are split", () => {
  assert.deepEqual(loaded.files.classes.map((f) => f.fileName.slice(f.fileName.lastIndexOf("/") + 1)).sort(), ["Bad.ts", "Relay.ts"]);
  assert.deepEqual(loaded.files.tests.map((f) => f.fileName.slice(f.fileName.lastIndexOf("/") + 1)), ["Relay.test.ts"]);
});

const relay = buildHir(loaded, config, profile, [fileOf("Relay.ts")]);

test("Relay.ts is clean (TypeScript and subset)", () => {
  assert.deepEqual(inFile(loaded.diagnostics, "src/Relay.ts"), []);
  assert.deepEqual(inFile(loaded.diagnostics, "src/Relay.test.ts"), []);
  assert.deepEqual(relay.diagnostics, []);
});

function allExprs(s: HirStmt, out: HirExpr[]): void {
  const walk = (e: HirExpr): void => {
    out.push(e);
    switch (e.k) {
      case "getOn": case "field": walk(e.obj); break;
      case "out": walk(e.call); break;
      case "call": if (e.target) walk(e.target); e.args.forEach((a) => walk(a.value)); break;
      case "cast": case "isValid": walk(e.value); break;
      case "optional": walk(e.value); walk(e.then); break;
      case "eq": case "and": case "or": walk(e.a); walk(e.b); break;
      case "not": walk(e.e); break;
      case "length": walk(e.array); break;
      default: break;
    }
  };
  switch (s.k) {
    case "expr": walk(s.e); break;
    case "setSelf": walk(s.value); break;
    case "const": walk(s.init); break;
    case "if": walk(s.cond); s.then.forEach((x) => allExprs(x, out)); s.else.forEach((x) => allExprs(x, out)); break;
    case "forOf": walk(s.array); s.body.forEach((x) => allExprs(x, out)); break;
    default: break;
  }
}

test("HIR of Relay.UpdateTarget", () => {
  assert.equal(relay.classes.length, 1);
  const cls = relay.classes[0]!;
  assert.equal(cls.name, "BP_Relay");
  assert.equal(cls.path, "/TestMod/Relay/BP_Relay");
  assert.equal(cls.classPath, "/TestMod/Relay/BP_Relay.BP_Relay_C");
  assert.equal(cls.parent, "/Script/FakeEngine.Actor");
  assert.deepEqual(cls.manualUnits, ["HideAll"]);
  assert.equal(cls.events.length, 1);
  const ev = cls.events[0]!;
  assert.equal(ev.name, "UpdateTarget");
  assert.deepEqual(ev.params, []);
  assert.deepEqual(
    ev.body.map((s) => s.k),
    ["const", "const", "if", "const", "if", "setSelf", "setSelf", "const", "if", "const", "if", "forOf", "setSelf"],
  );

  const consts = ev.body.filter((s): s is Extract<HirStmt, { k: "const" }> => s.k === "const");
  assert.deepEqual(consts.map((c) => [c.name, c.uses]), [["player", 1], ["pot", 6], ["rowName", 2], ["row", 2], ["info", 6]]);
  assert.equal(consts[0]!.init.k, "cast");
  assert.equal(consts[3]!.init.type, "result");

  const exprs: HirExpr[] = [];
  ev.body.forEach((s) => allExprs(s, exprs));
  assert.deepEqual(exprs.flatMap((e) => (e.k === "eq" ? [e.kind] : [])), ["object", "name", "real", "real", "int"]);
  const loop = ev.body.find((s): s is Extract<HirStmt, { k: "forOf" }> => s.k === "forOf");
  assert.equal(loop?.elem, "object:/Game/Fake/WBP_Show.WBP_Show_C");
  assert.equal(loop?.name, "w");
  const exec = exprs.find((e) => e.k === "execIs");
  assert.ok(exec && exec.k === "execIs" && exec.pin === "Valid" && exec.negate);
  const casts = exprs.flatMap((e) => (e.k === "cast" ? [e.castPin] : []));
  assert.deepEqual(casts, ["AsBPFakeCharacter", "AsBPFakePot"]);

  assert.equal(relay.classMeta["/Game/Fake/WBP_Show.WBP_Show_C"], "/Script/UMG.WidgetBlueprintGeneratedClass");
  assert.equal(relay.classMeta["/Game/Fake/BP_FakePot.BP_FakePot_C"], "/Script/Engine.BlueprintGeneratedClass");
  assert.equal(relay.classMeta["/TestMod/Relay/BP_Relay.BP_Relay_C"], "/Script/Engine.BlueprintGeneratedClass");
});

test("Bad.ts: every marked error is reported at its line and column, and nothing else", () => {
  const text = readFileSync(`${projectDir}/src/Bad.ts`, "utf8").split(/\r?\n/);
  const expected: Array<{ line: number; code: string; col: number | undefined }> = [];
  text.forEach((raw, i) => {
    const m = /\/\/ ((?:ABFC\d{4}\s*)+)(?:@(.*))?$/.exec(raw);
    if (!m) return;
    const codes = m[1]!.trim().split(/\s+/);
    const snippet = m[2]?.trimEnd();
    for (const code of codes) expected.push({ line: i + 1, code, col: snippet !== undefined && codes.length === 1 ? raw.indexOf(snippet) + 1 : undefined });
  });
  assert.ok(expected.length >= 18, "Bad.ts carries one marker per error");

  const hir = buildHir(loaded, config, profile, [fileOf("Bad.ts")]);
  const actual = inFile([...loaded.diagnostics, ...hir.diagnostics], "src/Bad.ts");
  assert.ok(actual.every((d) => d.severity === "error"));
  const key = (line: number, code: string): string => `${line}:${code}`;
  assert.deepEqual(
    [...new Set(actual.map((d) => key(d.span!.line, d.code)))].sort(),
    [...new Set(expected.map((e) => key(e.line, e.code)))].sort(),
  );
  for (const e of expected) {
    if (e.col === undefined) continue;
    const hits = actual.filter((d) => d.code === e.code && d.span?.line === e.line);
    assert.ok(hits.some((d) => d.span?.col === e.col), `${e.code} on line ${e.line} should start at column ${e.col}, got ${hits.map((d) => d.span?.col).join(",")}`);
  }
  const codes = new Set(actual.map((d) => d.code));
  for (const c of ["ABFC2000", "ABFC2001", "ABFC2010", "ABFC2011", "ABFC2013", "ABFC2014", "ABFC2020", "ABFC2040", "ABFC2050", "ABFC2052", "ABFC2053", "ABFC2060", "ABFC2099", "ABFC3004"]) {
    assert.ok(codes.has(c), `Bad.ts should trigger ${c}`);
  }
});

test("TypeScript errors carry the [TSnnnn] prefix and a 1-based position", () => {
  const ts2322 = loaded.diagnostics.find((d) => d.span?.file === "src/Bad.ts" && d.message.startsWith("[TS2322]"));
  assert.ok(ts2322);
  assert.equal(ts2322.code, "ABFC2000");
  assert.ok(ts2322.span && ts2322.span.line >= 1 && ts2322.span.col >= 1 && ts2322.span.endCol > ts2322.span.col);
});

test("checkSubset reports one file's diagnostics", () => {
  const ds = checkSubset(loaded, fileOf("Bad.ts"), config, profile);
  assert.ok(ds.some((d) => d.code === "ABFC2000"));
  assert.ok(ds.some((d) => d.code === "ABFC2010"));
  assert.deepEqual(checkSubset(loaded, fileOf("Relay.ts"), config, profile), []);
});

test("compileTests: steps JSON", () => {
  const { cases, diagnostics } = compileTests(loaded, profile);
  assert.deepEqual(diagnostics, []);
  const view = cases.map((c) => ({ name: c.name, file: c.file, steps: c.steps.map((s) => (s.knownIssue === undefined ? s.step : { ...s.step, knownIssue: s.knownIssue })) }));
  const cls = "/TestMod/Relay/BP_Relay.BP_Relay_C";
  assert.deepEqual(view, [
    {
      name: "update target clears without a pot",
      file: "src/Relay.test.ts",
      steps: [
        { op: "spawn", class: cls, as: "relay" },
        { op: "call", target: "$relay", function: "UpdateTarget", args: [] },
        { op: "get", target: "$relay", property: "Visible", as: "_v0" },
        { op: "assert", value: "$_v0", equals: false },
        { op: "python", code: "result=str(ctx['relay'].get_editor_property('LastTarget'))", as: "last" },
        { op: "assert", value: "$last", equals: "None" },
        { op: "wait", seconds: 0.5 },
      ],
    },
    {
      name: "assertion forms",
      file: "src/Relay.test.ts",
      steps: [
        { op: "spawn", class: cls, as: "relay" },
        { op: "set", target: "$relay", property: "Visible", value: true },
        { op: "get", target: "$relay", property: "Visible", as: "vis" },
        { op: "assert", value: "$vis", truthy: true },
        { op: "get", target: "$relay", property: "LastName", as: "_v0" },
        { op: "assert", value: "$_v0", contains: "Row" },
        { op: "call", target: "$relay", function: "HideAll", args: [], as: "_v1" },
        { op: "assert", value: "$_v1", not_none: true, knownIssue: "pre-existing" },
        { op: "python", code: "result=1.0", as: "v", knownIssue: "wrong name in this build" },
        { op: "assert", value: "$v", approx: 1, tolerance: 0.01 },
        { op: "python", code: "result=None" },
      ],
    },
  ]);
  const first = cases[0]!;
  assert.equal(first.span.file, "src/Relay.test.ts");
  assert.equal(first.steps[1]!.span.line, 6);
  assert.equal(first.steps[3]!.span.line, 7);
});

test("compileTests: filter keeps matching names and files", () => {
  assert.equal(compileTests(loaded, profile, "assertion").cases.length, 1);
  assert.equal(compileTests(loaded, profile, "Relay.test").cases.length, 2);
  assert.equal(compileTests(loaded, profile, "nothing like this").cases.length, 0);
});

// ---- Phase 2: overrides, own calls, delegates, enums, widgets, spawns, arithmetic ----

const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));
const loaded2 = loadProgram(phase2Dir);
const file2 = (name: string) => {
  const sf = loaded2.files.classes.find((f) => f.fileName.endsWith(`/${name}`));
  assert.ok(sf, `${name} is a root file`);
  return sf;
};
const director = buildHir(loaded2, config, profile, [file2("Director.ts")]);

function walkExprs(s: HirStmt, out: HirExpr[]): void {
  const walk = (e: HirExpr): void => {
    out.push(e);
    switch (e.k) {
      case "getOn": case "field": walk(e.obj); break;
      case "out": walk(e.call); break;
      case "call": if (e.target) walk(e.target); e.args.forEach((a) => walk(a.value)); break;
      case "callOwn": e.args.forEach((a) => walk(a.value)); break;
      case "cast": case "isValid": walk(e.value); break;
      case "optional": walk(e.value); walk(e.then); break;
      case "eq": case "and": case "or": case "arith": case "cmp": walk(e.a); walk(e.b); break;
      case "not": walk(e.e); break;
      case "length": walk(e.array); break;
      case "index": walk(e.array); walk(e.index); break;
      case "arrayFind": walk(e.array); walk(e.value); break;
      case "createWidget": walk(e.owner); break;
      case "spawn": if (e.owner) walk(e.owner); break;
      default: break;
    }
  };
  switch (s.k) {
    case "setSelfCond": walk(s.cond); walk(s.a); walk(s.b); break;
    case "forCount": walk(s.init); walk(s.cond); s.body.forEach((x) => walkExprs(x, out)); break;
    case "arrayOp": if (s.value) walk(s.value); if (s.index) walk(s.index); break;
    case "expr": walk(s.e); break;
    case "setSelf": walk(s.value); break;
    case "const": walk(s.init); break;
    case "if": walk(s.cond); s.then.forEach((x) => walkExprs(x, out)); s.else.forEach((x) => walkExprs(x, out)); break;
    case "forOf": walk(s.array); s.body.forEach((x) => walkExprs(x, out)); break;
    default: break;
  }
}

test("Director.ts is clean and its class options are accepted", () => {
  assert.deepEqual(inFile(loaded2.diagnostics, "src/Director.ts"), []);
  assert.deepEqual(director.diagnostics, []);
  assert.equal(director.classes.length, 1);
  assert.deepEqual(director.classes[0]!.defaults, { bReplicates: "True", NetUpdateFrequency: "2.000000", TickInterval: "0.100000" });
});

test("HIR of the Director: override, events, docs", () => {
  const cls = director.classes[0]!;
  assert.deepEqual(cls.events.map((e) => [e.name, e.kind]), [["ReceiveTick", "override"], ["Step", "event"], ["Announce", "event"], ["Start", "event"], ["Scan", "event"]]);
  const ov = cls.events[0]!;
  assert.equal(ov.overrideOf, "/Script/FakeEngine.Actor");
  assert.deepEqual(ov.params.map((p) => p.name), ["DeltaSeconds"]);
  assert.equal(ov.doc, "Forwards the engine tick.");
  assert.equal(cls.events[1]!.doc, "Counts the elapsed time down and bumps the counter.");
  assert.equal(cls.events[1]!.overrideOf, undefined);
  assert.equal(cls.events[2]!.doc, undefined);
});

test("HIR of the Director: own calls, arithmetic and comparisons", () => {
  const ev = (n: string) => director.classes[0]!.events.find((e) => e.name === n)!;
  const exprsOf = (n: string): HirExpr[] => {
    const out: HirExpr[] = [];
    ev(n).body.forEach((s) => walkExprs(s, out));
    return out;
  };
  const tick = exprsOf("ReceiveTick").find((e) => e.k === "callOwn");
  assert.ok(tick && tick.k === "callOwn" && tick.name === "Step" && tick.args.length === 1 && tick.args[0]!.pin === "Delta");

  const step = exprsOf("Step");
  assert.deepEqual(step.flatMap((e) => (e.k === "arith" ? [[e.op, e.kind]] : [])), [["-", "real"], ["+", "int"], ["*", "real"]]);
  assert.deepEqual(step.flatMap((e) => (e.k === "cmp" ? [[e.op, e.kind]] : [])), [["<=", "real"], [">=", "int"], [">", "real"]]);
  const own = step.find((e) => e.k === "callOwn");
  assert.ok(own && own.k === "callOwn" && own.name === "Announce" && own.args.map((a) => a.pin).join() === "N,Left");
  assert.ok(exprsOf("Announce").some((e) => e.k === "cmp" && e.op === "<" && e.kind === "int"));
});

test("HIR of the Director: delegate, enum, class, widget, spawn and name literals", () => {
  const ev = (n: string) => director.classes[0]!.events.find((e) => e.name === n)!;
  const collect = (n: string): HirExpr[] => {
    const out: HirExpr[] = [];
    ev(n).body.forEach((s) => walkExprs(s, out));
    return out;
  };
  const start = collect("Start");
  const del = start.find((e) => e.k === "delegateRef");
  assert.ok(del && del.k === "delegateRef" && del.event === "Scan");
  const cw = start.find((e) => e.k === "createWidget");
  assert.ok(cw && cw.k === "createWidget" && cw.cls === "/Game/Fake/WBP_Panel.WBP_Panel_C");
  const en = start.find((e) => e.k === "enumLit");
  assert.ok(en && en.k === "enumLit" && en.text === "Collapsed" && en.enumPath === "/Script/FakeEngine.EFakeVisibility");
  const cr = start.find((e) => e.k === "classRef");
  assert.ok(cr && cr.k === "classRef" && cr.path === "/Game/Fake/WBP_Panel.WBP_Panel_C");

  const scan = collect("Scan");
  const sp = scan.find((e) => e.k === "spawn");
  assert.ok(sp && sp.k === "spawn" && sp.cls === "/Game/Fake/BP_FakePot.BP_FakePot_C" && sp.collision === "AlwaysSpawn" && sp.owner !== undefined && sp.scale === undefined);
  const nm = scan.find((e) => e.k === "nameLit");
  assert.ok(nm && nm.k === "nameLit" && nm.text === "Spawned");
  const idx = scan.find((e) => e.k === "index");
  assert.ok(idx && idx.k === "index" && idx.elem === "object:/Game/Fake/BP_FakePot.BP_FakePot_C");
});

// ---- statements: ternary assignment, counted for loops, array operations ----

const counter = buildHir(loaded2, config, profile, [file2("Counter.ts")]);

test("Counter.ts is clean", () => {
  assert.deepEqual(inFile(loaded2.diagnostics, "src/Counter.ts"), []);
  assert.deepEqual(counter.diagnostics, []);
  assert.equal(counter.classes[0]!.events.length, 2);
});

test("HIR of the Counter: this.X = c ? a : b", () => {
  const pick = counter.classes[0]!.events[0]!;
  assert.equal(pick.name, "Pick");
  assert.equal(pick.doc, "Picks the interval and the starting count from the armed flag.");
  assert.equal(pick.body.length, 2);
  const [first, second] = pick.body;
  assert.ok(first && first.k === "setSelfCond" && first.name === "Elapsed" && first.type === "double");
  assert.deepEqual([first.cond.k, first.a.k, first.b.k], ["getSelf", "getSelf", "getSelf"]);
  assert.ok(first.a.k === "getSelf" && first.a.name === "Fast" && first.b.k === "getSelf" && first.b.name === "Slow");
  assert.ok(second && second.k === "setSelfCond" && second.name === "Count" && second.cond.k === "and" && second.a.k === "lit" && second.b.k === "lit");
});

test("HIR of the Counter: counted for loops and array operations", () => {
  const sweep = counter.classes[0]!.events[1]!;
  const [down, up, find, clear] = sweep.body;
  assert.ok(down && down.k === "forCount" && down.name === "i" && down.step === -1);
  assert.ok(down.init.k === "arith" && down.init.op === "-" && down.init.kind === "int" && down.init.a.k === "length");
  assert.ok(down.cond.k === "cmp" && down.cond.op === ">=" && down.cond.kind === "int" && down.cond.a.k === "local" && down.cond.a.id === down.counter);
  const [pot, check] = down.body;
  assert.ok(pot && pot.k === "const" && pot.init.k === "index" && pot.init.index.k === "local" && pot.init.index.id === down.counter);
  assert.ok(check && check.k === "if");
  assert.deepEqual(check.then.map((s) => (s.k === "arrayOp" ? [s.op, s.array.self, s.array.type, s.index?.k] : s.k)), [
    ["removeAt", "Pots", "array:object:/Game/Fake/BP_FakePot.BP_FakePot_C", "local"],
    ["removeAt", "Names", "array:name", "local"],
  ]);

  assert.ok(up && up.k === "forCount" && up.name === "j" && up.step === 1 && up.init.k === "lit" && up.init.type === "int");
  const push = up.body[0];
  assert.ok(push && push.k === "arrayOp" && push.op === "push" && push.array.self === "Names" && push.value?.k === "nameLit");

  assert.ok(find && find.k === "if" && find.cond.k === "eq" && find.cond.kind === "int");
  assert.ok(find.cond.a.k === "arrayFind" && find.cond.a.elem === "name" && find.cond.a.type === "int" && find.cond.a.array.k === "getSelf" && find.cond.a.value.k === "nameLit");
  assert.ok(find.cond.b.k === "lit" && find.cond.b.value === -1);

  assert.ok(clear && clear.k === "arrayOp" && clear.op === "clear" && clear.array.self === "Names");
  assert.equal(sweep.body.length, 4);
});

test("Phase2Bad.ts: every marked error is reported at its line and column, and nothing else", () => {
  const text = readFileSync(`${phase2Dir}/src/Phase2Bad.ts`, "utf8").split(/\r?\n/);
  const expected: Array<{ line: number; code: string; col: number | undefined }> = [];
  text.forEach((raw, i) => {
    const m = /\/\/ ((?:ABFC\d{4}\s*)+)(?:@(.*))?$/.exec(raw);
    if (!m) return;
    const codes = m[1]!.trim().split(/\s+/);
    const snippet = m[2]?.trimEnd();
    for (const code of codes) expected.push({ line: i + 1, code, col: snippet !== undefined && codes.length === 1 ? raw.indexOf(snippet) + 1 : undefined });
  });
  assert.ok(expected.length >= 8);

  const hir = buildHir(loaded2, config, profile, [file2("Phase2Bad.ts")]);
  const actual = inFile([...loaded2.diagnostics, ...hir.diagnostics], "src/Phase2Bad.ts");
  assert.ok(actual.every((d) => d.severity === "error"));
  const key = (line: number, code: string): string => `${line}:${code}`;
  assert.deepEqual(
    [...new Set(actual.map((d) => key(d.span!.line, d.code)))].sort(),
    [...new Set(expected.map((e) => key(e.line, e.code)))].sort(),
  );
  for (const e of expected) {
    if (e.col === undefined) continue;
    const hits = actual.filter((d) => d.code === e.code && d.span?.line === e.line);
    assert.ok(hits.some((d) => d.span?.col === e.col), `${e.code} on line ${e.line} should start at column ${e.col}, got ${hits.map((d) => d.span?.col).join(",")}`);
  }
});
