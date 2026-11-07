import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RuleTester } from "@typescript-eslint/rule-tester";
import noUnboundedArrayGrowth from "../src/rules/no-unbounded-array-growth.js";
import replicatedWriteNeedsAuthority from "../src/rules/replicated-write-needs-authority.js";
import rpcMisuse from "../src/rules/rpc-misuse.js";

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

// The fixture lives in the source tree (tests run from dist/test).
const fixtureDir = fileURLToPath(new URL("../../test/fixture", import.meta.url));

const typed = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: { allowDefaultProject: ["*.ts"], defaultProject: "tsconfig.json" },
      tsconfigRootDir: fixtureDir,
    },
  },
});

// The default project ignores the tsconfig include list, so each sample pulls the stubs in explicitly.
const STUBS = '/// <reference path="./stubs.d.ts" />\n';

type Case = string | { code: string; [key: string]: unknown };
const withStubs = (c: Case): Case => (typeof c === "string" ? STUBS + c : { ...c, code: STUBS + c.code });

function runTyped(
  name: string,
  rule: Parameters<typeof typed.run>[1],
  cases: { valid: Case[]; invalid: Extract<Case, object>[] },
): void {
  typed.run(name, rule, { valid: cases.valid.map(withStubs), invalid: cases.invalid.map(withStubs) } as never);
}

const untyped = new RuleTester();

runTyped("replicated-write-needs-authority", replicatedWriteNeedsAuthority as never, {
  valid: [
    // not replicated
    `class A extends StubActor { @event Go() { this.Local = 1; this.Log.push("x"); } }`,
    // guarded by an if
    `class A extends StubActor { @event Go() { if (this.HasAuthority()) { this.Score = 1; } } }`,
    // guarded through && and a custom authority call
    `class A extends StubActor { @event Go() { if (this.Local > 0 && this.IsServer()) { this.Names.push("x"); } } }`,
    // early-return guard
    `class A extends StubActor { @event Go() { if (!this.HasAuthority()) return; this.Score = this.Score + 1; } }`,
    `class A extends StubActor { @event Go() { if (!this.HasAuthority()) { return; } this.Names.length = 0; } }`,
    // else branch of a negated check
    `class A extends StubActor { @event Go() { if (!this.HasAuthority()) { this.Local = 1; } else { this.Score = 2; } } }`,
    // conditional expression
    `class A extends StubActor { @event Go() { this.HasAuthority() ? this.Score++ : 0; } }`,
    // reading is fine
    `class A extends StubActor { @event Go() { this.Local = this.Score; const n = this.Names.length; } }`,
    // a write to the same name on a class that does not inherit the replicated member
    `class B { Score = 0; @event Go() { this.Score = 1; } }`,
    // constructor defaults
    `class A extends StubActor { constructor() { super(); this.Score = 0; } }`,
    // custom authority call list
    {
      code: `class A extends StubActor { @event Go() { if (this.Plain()) { this.Score = 1; } } }`,
      options: [{ authorityCalls: ["Plain"] }],
    },
  ],
  invalid: [
    {
      code: `class A extends StubActor { @event Go() { this.Score = 1; } }`,
      errors: [{ messageId: "authority", data: { name: "Score" } }],
    },
    {
      code: `class A extends StubActor { @event Go() { this.Score += 1; this.Score++; } }`,
      errors: [{ messageId: "authority" }, { messageId: "authority" }],
    },
    {
      code: `class A extends StubActor { @event Go() { this.Names.push("x"); this.Names.splice(0, 1); this.Names.length = 0; } }`,
      errors: [
        { messageId: "authority", data: { name: "Names" } },
        { messageId: "authority", data: { name: "Names" } },
        { messageId: "authority", data: { name: "Names" } },
      ],
    },
    // the wrong branch of the authority check
    {
      code: `class A extends StubActor { @event Go() { if (this.HasAuthority()) { this.Local = 1; } else { this.Score = 2; } } }`,
      errors: [{ messageId: "authority" }],
    },
    // an early return that does not test authority
    {
      code: `class A extends StubActor { @event Go() { if (this.Local > 0) return; this.Score = 1; } }`,
      errors: [{ messageId: "authority" }],
    },
    // a guard of another method does not count
    {
      code: `class A extends StubActor { @event Go() { if (this.HasAuthority()) { this.Local = 1; } } @event Other() { this.Score = 3; } }`,
      errors: [{ messageId: "authority" }],
    },
    // the guard is not honoured when the option replaces the list
    {
      code: `class A extends StubActor { @event Go() { if (this.HasAuthority()) { this.Score = 1; } } }`,
      options: [{ authorityCalls: ["IsServer"] }],
      errors: [{ messageId: "authority" }],
    },
  ],
});

runTyped("rpc-misuse", rpcMisuse as never, {
  valid: [
    // server RPC from anywhere
    `class A extends StubActor { @event Go() { this.Ask(); } }`,
    // client and multicast RPCs from the server
    `class A extends StubActor { @event Go() { if (this.HasAuthority()) { this.Notify(); this.Boom(); } } }`,
    `class A extends StubActor { @event Go() { if (!this.HasAuthority()) return; this.Notify(); } }`,
    // a reliable RPC once, outside tick and loops
    `class A extends StubActor { @event Go() { if (this.HasAuthority()) { this.Boom(); } } }`,
    // a server RPC in tick is fine (only reliable ones are flagged)
    `class A extends StubActor { @override ReceiveTick(dt: number) { this.Ask(); } }`,
    // a plain method
    `class A extends StubActor { @override ReceiveTick(dt: number) { this.Plain(); } }`,
    // custom tick list
    {
      code: `class A extends StubActor { @override ReceiveTick(dt: number) { if (this.HasAuthority()) { this.Boom(); } } }`,
      options: [{ tickMethods: ["OtherTick"] }],
    },
  ],
  invalid: [
    {
      code: `class A extends StubActor { @event Go() { this.Notify(); } }`,
      errors: [{ messageId: "clientFromClient", data: { name: "Notify", kind: "client" } }],
    },
    {
      code: `class A extends StubActor { @event Go() { if (!this.HasAuthority()) { this.Boom(); } } }`,
      errors: [{ messageId: "clientFromClient", data: { name: "Boom", kind: "multicast" } }],
    },
    // reliable multicast in tick: both problems
    {
      code: `class A extends StubActor { @override ReceiveTick(dt: number) { if (this.HasAuthority()) { this.Boom(); } } }`,
      errors: [{ messageId: "reliableSpam", data: { name: "Boom" } }],
    },
    // reliable in a loop
    {
      code: `class A extends StubActor { @event Go() { if (this.HasAuthority()) { for (let i = 0; i < 3; i++) { this.Boom(); } } } }`,
      errors: [{ messageId: "reliableSpam" }],
    },
    {
      code: `class A extends StubActor { @event Go() { for (const x of [1, 2]) { this.Boom(); } } }`,
      errors: [{ messageId: "clientFromClient" }, { messageId: "reliableSpam" }],
    },
  ],
});

untyped.run("replicated-write-needs-authority without type information", replicatedWriteNeedsAuthority, {
  valid: [`class A { @event Go() { this.Score = 1; } }`],
  invalid: [],
});

untyped.run("rpc-misuse without type information", rpcMisuse, {
  valid: [`class A { @event Go() { this.Notify(); } }`],
  invalid: [],
});

untyped.run("no-unbounded-array-growth", noUnboundedArrayGrowth, {
  valid: [
    // cleared somewhere in the class
    `class A { Items: number[] = []; @event Add() { this.Items.push(1); } @event Reset() { this.Items.length = 0; } }`,
    `class A { Items: number[] = []; @event Add() { this.Items.push(1); } @event Take() { this.Items.splice(0, 1); } }`,
    `class A { Items: number[] = []; @event Add() { this.Items.push(1); } @event Take() { return this.Items.pop(); } }`,
    `class A { Items: number[] = []; @event Add() { this.Items.push(1); } @event Take() { this.Items.shift(); } }`,
    `class A { Items: number[] = []; @event Add() { this.Items.push(1); } @event Reset() { this.Items = []; } }`,
    // bounded by a length check
    `class A { Items: number[] = []; @event Add() { if (this.Items.length < 10) { this.Items.push(1); } } }`,
    `class A { Items: number[] = []; @event Add() { if (this.Armed) { if (this.Items.length < 10) this.Items.push(1); } } }`,
    // deduplicated
    `class A { Items: number[] = []; @event Add(x: number) { if (!this.Items.includes(x)) { this.Items.push(x); } } }`,
    `class A { Items: number[] = []; @event Add(x: number) { if (this.Items.indexOf(x) < 0) { this.Items.push(x); } } }`,
    // a local array is not a field
    `class A { @event Add() { const tmp: number[] = []; tmp.push(1); } }`,
    // ignored by option
    {
      code: `class A { Items: number[] = []; @event Add() { this.Items.push(1); } }`,
      options: [{ ignore: ["Items"] }],
    },
    // push and clear in the same class
    `class A { Items: number[] = []; Other: number[] = []; @event Add() { this.Items.push(1); this.Items.length = 0; } }`,
  ],
  invalid: [
    {
      code: `class A { Items: number[] = []; @event Add() { this.Items.push(1); } }`,
      errors: [{ messageId: "grows", data: { name: "Items" } }],
    },
    // clearing a different array does not help
    {
      code: `class A { Items: number[] = []; Other: number[] = []; @event Add() { this.Items.push(1); } @event Reset() { this.Other.length = 0; } }`,
      errors: [{ messageId: "grows", data: { name: "Items" } }],
    },
    // the check mentions another array
    {
      code: `class A { Items: number[] = []; Other: number[] = []; @event Add() { if (this.Other.length < 3) { this.Items.push(1); } } }`,
      errors: [{ messageId: "grows" }],
    },
    // a check after the push is not a bound
    {
      code: `class A { Items: number[] = []; @event Add() { this.Items.push(1); if (this.Items.length > 3) { this.Log(); } } }`,
      errors: [{ messageId: "grows" }],
    },
    // a nested class does not use the outer class's clear
    {
      code: `class A { Items: number[] = []; @event Reset() { this.Items.length = 0; } B = class { Items: number[] = []; @event Add() { this.Items.push(1); } }; }`,
      errors: [{ messageId: "grows" }],
    },
    {
      code: `class A { Items: number[] = []; @event Add() { this.Items.push(1); this.Items.push(2); } }`,
      errors: [{ messageId: "grows" }, { messageId: "grows" }],
    },
  ],
});
