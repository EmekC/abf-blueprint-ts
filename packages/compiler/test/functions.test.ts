import { test } from "node:test";
import assert from "node:assert/strict";
import { validateIrModule } from "@abfc/ir";
import type { IrNode, IrUnit } from "@abfc/ir";
import { ASSET, codes, compile, compileFiles, irOf, unitById } from "./fn-harness.js";

const wired = (u: IrUnit, from: string, to: string): boolean => u.wires.some((w) => w[0] === from && w[1] === to);
const wiresInto = (u: IrUnit, to: string): string[] => u.wires.filter((w) => w[1] === to).map((w) => w[0]);
const callsOf = (u: IrUnit, fn: string): IrNode[] => u.nodes.filter((n) => n.sem?.k === "call" && n.sem.function === fn);

const GOAL = `
  @event Go(): void {
    const t = this.runTest(5);
    this.Last = t;
  }

  private runTest(amount: int): int {
    this.Count = this.Count + amount;
    return this.Count;
  }`;

test("Goal: an undecorated method is a function unit, its caller a self call node", () => {
  const ir = irOf(GOAL);
  assert.deepEqual(validateIrModule(ir), []);
  assert.deepEqual(ir.assets[0]!.units.map((u) => u.id).sort(), ["event:Go", "function:runTest"]);

  const fn = unitById(ir, "function:runTest");
  assert.equal(fn.kind, "function");
  assert.equal(fn.graph, "runTest");
  assert.equal(fn.name, "runTest");
  assert.deepEqual(fn.signature.inputs.map((p) => `${p.name}:${p.type}`), ["amount:int"]);
  assert.deepEqual(fn.signature.outputs.map((p) => `${p.name}:${p.type}`), ["ReturnValue:int"]);
  assert.equal(fn.signature.access, "private");

  // no entry or result node is emitted: the wires use the backend's reserved ids
  assert.ok(fn.nodes.every((n) => n.sem?.k !== "event"));
  assert.ok(fn.wires.some((w) => w[0] === "entry.then"));
  assert.ok(fn.wires.some((w) => w[1] === "result.execute"));
  assert.equal(wiresInto(fn, "result.ReturnValue").length, 1);

  const caller = unitById(ir, "event:Go");
  const calls = callsOf(caller, "runTest");
  assert.equal(calls.length, 1);
  const sem = calls[0]!.sem;
  assert.equal(sem?.k, "call");
  if (sem?.k === "call") {
    assert.equal(sem.class, undefined); // a self call
  }
  // the call is impure: it sits in the exec chain
  assert.ok(caller.wires.some((w) => w[1] === `${calls[0]!.id}.execute`));
});

test("a void function: parameters only, an early return; the end of the body ends the chain", () => {
  const ir = irOf(`
  @event Go(): void { this.setIf(3); }
  setIf(n: int): void {
    if (n === 0) return;
    this.Count = n;
  }`);
  const fn = unitById(ir, "function:setIf");
  assert.deepEqual(fn.signature.outputs, []);
  assert.equal(fn.signature.access, "public");
  assert.equal(wiresInto(fn, "result.ReturnValue").length, 0);
  assert.deepEqual(validateIrModule(ir), []);
});

test("several returns go through the member temp abfc_<fn>_r", () => {
  const ir = irOf(`
  @event Go(): void { this.Last = this.clamp(this.Count); }
  clamp(a: int): int {
    if (a > 50) return 50;
    return a;
  }`);
  assert.deepEqual(validateIrModule(ir), []);
  const fn = unitById(ir, "function:clamp");
  const temp = ir.assets[0]!.variables.find((v) => v.name === "abfc_clamp_r");
  assert.ok(temp);
  assert.equal(temp.type, "int");
  assert.equal(temp.temp, true);
  const sets = fn.nodes.filter((n) => n.sem?.k === "set" && n.sem.name === "abfc_clamp_r");
  const gets = fn.nodes.filter((n) => n.sem?.k === "get" && n.sem.name === "abfc_clamp_r");
  assert.equal(sets.length, 2);
  assert.equal(gets.length, 1);
  // each set ends the exec chain at the result node, one get feeds the return value
  for (const s of sets) assert.ok(wired(fn, `${s.id}.then`, "result.execute"), `${s.id} -> result.execute`);
  assert.equal(wiresInto(fn, "result.ReturnValue").length, 1);
  assert.ok(wiresInto(fn, "result.ReturnValue")[0]!.startsWith(`${gets[0]!.id}.`));
});

test("a single trailing return of a pin is wired straight to result.ReturnValue (no temp)", () => {
  const ir = irOf(GOAL);
  assert.equal(ir.assets[0]!.variables.some((v) => v.name === "abfc_runTest_r"), false);
});

test("a literal return value compiles to a valid unit with one output", () => {
  const ir = irOf(`
  @event Go(): void { this.Last = this.seven(); }
  seven(): int { return 7; }`);
  assert.deepEqual(validateIrModule(ir), []);
  assert.equal(unitById(ir, "function:seven").signature.outputs.length, 1);
  assert.equal(wiresInto(unitById(ir, "function:seven"), "result.ReturnValue").length, 1);
});

test("calls before the declaration and function to function calls compile", () => {
  const ir = irOf(`
  @event Go(): void { this.Last = this.outer(1); }
  outer(a: int): int { return this.inner(a) + 1; }
  inner(b: int): int { return b * 2; }`);
  assert.deepEqual(validateIrModule(ir), []);
  assert.equal(callsOf(unitById(ir, "function:outer"), "inner").length, 1);
  assert.equal(callsOf(unitById(ir, "event:Go"), "outer").length, 1);
});

test("recursion (direct and mutual) is ABFC2085 at the function name, once per cycle", () => {
  const direct = compile(`
  @event Go(): void { this.f(3); }
  f(n: int): int { return this.f(n - 1); }`);
  assert.deepEqual(codes(direct), ["ABFC2085"]);
  assert.match(direct.hir.diagnostics[0]!.message, /f calls itself \(f -> f\)/);

  const mutual = compile(`
  @event Go(): void { this.a(3); }
  a(n: int): void { this.b(n); }
  b(n: int): void { this.a(n); }`);
  assert.deepEqual(codes(mutual), ["ABFC2085"]);
  assert.match(mutual.hir.diagnostics[0]!.message, /Recursion is not supported/);

  // a cycle that runs through events, with the function reached over a cross edge
  const viaEvents = compile(`
  @event E1(): void { this.E2(); this.F(); }
  @event E2(): void { this.E1(); }
  F(): void { this.E2(); }`);
  assert.deepEqual(codes(viaEvents), ["ABFC2085"]);
  assert.match(viaEvents.hir.diagnostics[0]!.message, /F calls itself \(F -> E2 -> E1 -> F\)/);

  // a diamond is not a cycle
  assert.deepEqual(codes(compile(`
  @event Go(): void { this.a(3); this.b(3); }
  a(n: int): void { this.c(n); }
  b(n: int): void { this.c(n); }
  c(n: int): void { this.Count = n; }`)), []);
});

test("await and latent calls in a function are ABFC2086; an event may use them", () => {
  const awaited = compile(`
  async later(): Promise<void> { await KismetSystemLibrary.Delay(1); }`);
  assert.ok(codes(awaited).includes("ABFC2086"));

  const latent = compile(`
  wait(): void { KismetSystemLibrary.Delay(1); }`);
  assert.deepEqual(codes(latent), ["ABFC2086"]);
  assert.match(latent.hir.diagnostics[0]!.message, /Delay is a latent action and cannot be called inside the function wait/);

  const inEvent = compile(`
  @event Go(): void { KismetSystemLibrary.Delay(1); }`);
  assert.deepEqual(codes(inEvent), []);
});

test("a method named like a member of the parent class is ABFC2087", () => {
  const c = compile(`
  GetPawnThing(): Actor | null { return null; }`, "FakeController");
  assert.deepEqual(codes(c), ["ABFC2087"]);
  assert.match(c.hir.diagnostics[0]!.message, /method GetPawnThing has the name of/);

  assert.deepEqual(codes(compile(`UserConstructionScript(): void {}`)), ["ABFC2087"]);
  assert.deepEqual(codes(compile(`ExecuteUbergraph_X(): void {}`)), ["ABFC2087"]);
});

test("unsupported method forms stay ABFC2099 with a specific message", () => {
  const msg = (members: string): string => {
    const c = compile(members);
    assert.deepEqual(codes(c), ["ABFC2099"], members);
    return c.hir.diagnostics[0]!.message;
  };
  assert.match(msg(`get total(): int { return 1; }`), /getters and setters are not supported/);
  assert.match(msg(`set total(v: int) { this.Count = v; }`), /getters and setters are not supported/);
  assert.match(msg(`static make(): void {}`), /static methods are not supported/);
  assert.match(msg(`opt(a?: int): void {}`), /optional parameters and default values are not supported/);
  assert.match(msg(`dflt(a: int = 3): void {}`), /optional parameters and default values are not supported/);
  assert.match(msg(`rest(...a: int[]): void {}`), /rest parameters are not supported/);
  assert.match(msg(`generic<T>(a: int): void {}`), /generic methods are not supported/);
  assert.match(msg(`#hidden(): void {}`), /private names \(#x\) are not supported/);
});

test("an @event cannot return a value; a void function cannot either", () => {
  const ev = compile(`@event Go(): void { return 1; }`);
  assert.ok(ev.hir.diagnostics.some((d) => d.code === "ABFC2099" && /cannot return a value/.test(d.message)));
  const vf = compile(`
  @event Go(): void { this.f(); }
  f(): void { return 1; }`);
  assert.ok(vf.hir.diagnostics.some((d) => d.code === "ABFC2099" && /void function cannot return a value/.test(d.message)));
});

test("access: protected and public (the default) are carried in the signature and its hash", () => {
  const ir = irOf(`
  @event Go(): void { this.a(); this.b(); }
  protected a(): void { this.Count = 1; }
  b(): void { this.Count = 2; }`);
  assert.equal(unitById(ir, "function:a").signature.access, "protected");
  assert.equal(unitById(ir, "function:b").signature.access, "public");
  const ir2 = irOf(`
  @event Go(): void { this.a(); this.b(); }
  private a(): void { this.Count = 1; }
  b(): void { this.Count = 2; }`);
  assert.notEqual(unitById(ir, "function:a").hash, unitById(ir2, "function:a").hash);
  assert.equal(unitById(ir, "function:b").hash, unitById(ir2, "function:b").hash);
});

test("another TS Blueprint class calls other.fn(x): a call node with the class of that Blueprint", () => {
  const other = `import { blueprint } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_Other" })
export class BP_Other extends Actor {
  Value!: int;
  double(x: int): int { return x * 2; }
}
`;
  const printer = `import { blueprint, event } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { BP_Other } from "./Other.js";

@blueprint({ path: "${ASSET}" })
export class BP_Printer extends Actor {
  Last!: int;
  @event Go(other: BP_Other): void {
    this.Last = other.double(4);
  }
}
`;
  const c = compileFiles({ "Printer.ts": printer, "Other.ts": other });
  assert.deepEqual(c.hir.diagnostics.map((d) => `${d.code} ${d.message}`), []);
  assert.ok(c.ir);
  const call = callsOf(unitById(c.ir, "event:Go"), "double")[0];
  assert.ok(call);
  assert.equal(call.sem?.k === "call" ? call.sem.class : undefined, "/TestMod/Relay/BP_Other.BP_Other_C");
});
