import { blueprint, event, struct } from "@abfc/runtime";
import type { int, name } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@struct({ path: "/TestMod/Phase4/S_Outer" })
export class S_Outer {
  Inner!: S_Entry;
  Total!: int;
}

@struct({ path: "/TestMod/Phase4/S_Entry" })
export class S_Entry {
  Count!: int;
  Label!: name;
  Seen!: boolean;
}

@blueprint({ path: "/TestMod/Phase4/BP_StructUser" })
export class BP_StructUser extends Actor {
  Entry!: S_Entry;
  Total!: int;

  @event
  Use(): void {
    this.Total = this.Entry.Count + 1;
    this.Entry = { Count: 2, Label: "x", Seen: true };
  }
}
