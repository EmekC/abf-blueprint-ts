import { blueprint, event, isValid, nameOf } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import type { BP_Counter_Manual } from "/TestMod/Relay/BP_Counter";

export interface BP_Counter extends BP_Counter_Manual {} // Count, Elapsed, Fast, Slow, Armed, Names, Pots

@blueprint({ path: "/TestMod/Relay/BP_Counter" })
export class BP_Counter extends Actor {
  /** Picks the interval and the starting count from the armed flag. */
  @event
  Pick(): void {
    this.Elapsed = this.Armed ? this.Fast : this.Slow;
    this.Count = this.Count > 2 && this.Armed ? 1 : 0;
  }

  @event
  Sweep(): void {
    for (let i = this.Pots.length - 1; i >= 0; i--) {
      const pot = this.Pots[i];
      if (!isValid(pot)) {
        this.Pots.splice(i, 1);
        this.Names.splice(i, 1);
      }
    }
    for (let j = 0; j < 3; j = j + 1) {
      this.Names.push(nameOf("Slot"));
    }
    if (this.Names.indexOf(nameOf("Slot")) === -1) this.Count = this.Count + 1;
    this.Names.length = 0;
  }
}
