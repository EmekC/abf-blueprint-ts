import { blueprint, event } from "@abfc/runtime";
import type { int, name } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Phase4/BP_Maps" })
export class BP_Maps extends Actor {
  Counts!: Map<name, int>;
  Seen!: Set<name>;
  Size!: int;

  @event
  Bump(key: name, by: int): void {
    if (this.Counts.has(key)) {
      this.Counts.set(key, this.Counts.get(key)! + by);
    } else {
      this.Counts.set(key, by);
    }
    this.Seen.add(key);
    this.Size = this.Counts.size + this.Seen.size;
  }

  @event
  Forget(key: name): void {
    this.Counts.delete(key);
    this.Seen.delete(key);
    this.Counts.clear();
    this.Seen.clear();
    if (this.Seen.has(key)) {
      this.Size = 1;
    }
  }
}
