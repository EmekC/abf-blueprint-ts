import { after, describe, it } from "node:test";
import { RuleTester } from "@typescript-eslint/rule-tester";
import noHeavyCallInTick from "../src/rules/no-heavy-call-in-tick.js";
import noLoopInTick from "../src/rules/no-loop-in-tick.js";

RuleTester.afterAll = after;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester();

ruleTester.run("no-heavy-call-in-tick", noHeavyCallInTick, {
  valid: [
    // not a tick method
    `class A { @event Refresh() { const all = GetAllActorsOfClass(Door); } }`,
    // BeginPlay runs once
    `class A { @override ReceiveBeginPlay() { this.Door = GetActorOfClass(Door); } }`,
    // a tick-named method that is not an override
    `class A { @event Tick() { const all = GetAllActorsOfClass(Door); } }`,
    // a callback is not the tick body (testkit style)
    `class A { @override ReceiveTick(dt: number) { test("x", () => { GetAllActorsOfClass(Door); }); } }`,
    // a harmless call in tick
    `class A { @override ReceiveTick(dt: number) { this.Elapsed = this.Elapsed + dt; } }`,
    // custom tick list does not include the method
    {
      code: `class A { @override ReceiveTick(dt: number) { GetAllActorsOfClass(Door); } }`,
      options: [{ tickMethods: ["OtherTick"] }],
    },
  ],
  invalid: [
    {
      code: `class A { @override ReceiveTick(dt: number) { const all = GetAllActorsOfClass(Door); } }`,
      errors: [{ messageId: "heavy", data: { name: "GetAllActorsOfClass", tick: "ReceiveTick" } }],
    },
    {
      code: `class A { @override Tick() { if (this.Armed) { this.World.GetActorOfClass(Door); } } }`,
      errors: [{ messageId: "heavy", data: { name: "GetActorOfClass", tick: "Tick" } }],
    },
    {
      code: `class A { @override ReceiveTick(dt: number) { createWidget(Hud); spawnActor(Door); } }`,
      errors: [{ messageId: "heavy" }, { messageId: "heavy" }],
    },
    {
      code: `class A { @override ReceiveTick(dt: number) { MyScan(); } }`,
      options: [{ extra: ["MyScan"] }],
      errors: [{ messageId: "heavy", data: { name: "MyScan", tick: "ReceiveTick" } }],
    },
    {
      code: `class A { @override OtherTick() { GetAllWidgetsOfClass(Hud); } }`,
      options: [{ tickMethods: ["OtherTick"] }],
      errors: [{ messageId: "heavy", data: { name: "GetAllWidgetsOfClass", tick: "OtherTick" } }],
    },
  ],
});

ruleTester.run("no-loop-in-tick", noLoopInTick, {
  valid: [
    `class A { @override ReceiveBeginPlay() { for (let i = 0; i < 3; i++) { this.Count = i; } } }`,
    `class A { @event Refresh() { for (const d of this.Doors) { d.Open(); } } }`,
    `class A { @override ReceiveTick(dt: number) { this.Items.forEach((i) => { while (i.Busy) { i.Wait(); } }); } }`,
    `class A { @override ReceiveTick(dt: number) { this.Elapsed = this.Elapsed + dt; } }`,
    {
      code: `class A { @override ReceiveTick(dt: number) { for (const d of this.Doors) { d.Open(); } } }`,
      options: [{ tickMethods: ["OtherTick"] }],
    },
  ],
  invalid: [
    {
      code: `class A { @override ReceiveTick(dt: number) { for (const d of this.Doors) { d.Open(); } } }`,
      errors: [{ messageId: "loop", data: { tick: "ReceiveTick" } }],
    },
    {
      code: `class A { @override Tick() { for (let i = 0; i < 3; i++) {} for (const k in this.M) {} } }`,
      errors: [{ messageId: "loop" }, { messageId: "loop" }],
    },
    {
      code: `class A { @override ReceiveTick(dt: number) { while (this.Busy) { this.Wait(); } do { this.Wait(); } while (this.Busy); } }`,
      errors: [{ messageId: "loop" }, { messageId: "loop" }],
    },
    {
      code: `class A { @override OtherTick() { while (true) {} } }`,
      options: [{ tickMethods: ["OtherTick"] }],
      errors: [{ messageId: "loop", data: { tick: "OtherTick" } }],
    },
  ],
});
