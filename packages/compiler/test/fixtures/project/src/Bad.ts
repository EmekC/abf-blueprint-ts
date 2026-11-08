import { blueprint, event, cast } from "@abfc/runtime";
import type { int, float } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { FakeLibrary as Lib } from "/Script/FakeGame";
import { BP_FakePot_C } from "/Game/Fake/BP_FakePot";
import { BP_FakeNoPin_C } from "/Game/Fake/BP_FakeNoPin";
import type { BP_Relay_Manual } from "/TestMod/Relay/BP_Relay";

// Every `// ABFCnnnn` marker names a diagnostic expected on that line; `@text` is where it must start (column).

@blueprint({ path: "/Elsewhere/BP_BadPath" }) // ABFC2001 @{ path: "/Elsewhere/BP_BadPath" }
export class BadPath extends Actor {}

export interface BP_Bad extends BP_Relay_Manual {}

@blueprint({ path: "/TestMod/Bad/BP_Bad" })
export class BP_Bad extends Actor {
  Score = 1; // ABFC2099 @Score = 1;

  static helper(): void {} // ABFC2099 @helper

  @event
  Numbers(a: int, b: int, f: float, n: number): void { // ABFC2014 @n: number
    const q = a / b; // ABFC2010 @a / b
    if (a == b) return; // ABFC2011 @a == b
    if (a === f) return; // ABFC2013 ABFC2000
    if (n === 3) return; // ABFC2014 @n === 3
  }

  @event
  Constructs(): void {
    const m = new Map<string, int>(); // ABFC2040 @new Map<string, int>()
    const fn = () => 1; // ABFC2020 @() => 1
    const z: any = 1; // ABFC2020 @z
    const arr = [...this.Widgets]; // ABFC2020 @...this.Widgets
    eval("1"); // ABFC2020 @eval("1")
    try { // ABFC2020 @try {
      this.HideAll();
    } finally {
      this.HideAll();
    }
    const bad: int = "x"; // ABFC2000 @bad: int
    while (true) { // ABFC2099 @while
      this.HideAll();
    }
  }

  @event
  Ordering(pot: BP_FakePot_C): void {
    const c1 = cast(this.OwnerPC, BP_FakePot_C); // ABFC2050 @const c1
    this.HideAll();
    const r = Lib.GetRow(pot.Row); // ABFC2052 @const r
    this.HideAll();
    const r2 = Lib.GetRow(pot.Row);
    if (r2.exec) { // ABFC2053 @r2.exec
      this.HideAll();
    }
    const p = pot.Plain; // ABFC2060 @Plain
    if (!cast(this.OwnerPC, BP_FakeNoPin_C)) return; // ABFC3004 @cast(this.OwnerPC, BP_FakeNoPin_C)
    throw new Error("x"); // ABFC2020 @throw
  }
}
