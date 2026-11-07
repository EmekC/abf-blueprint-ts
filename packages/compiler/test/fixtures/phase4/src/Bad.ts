import { blueprint, event } from "@abfc/runtime";
import type { int, name, text } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

// Every `// ABFCnnnn` marker names a diagnostic expected on that line.

@blueprint({ path: "/TestMod/Phase4/BP_BadMaps" })
export class BP_BadMaps extends Actor {
  Counts!: Map<name, int>;
  Seen!: Set<name>;
  Size!: int;
  BadText!: Map<text, int>; // ABFC2043
  BadValue!: Map<name, int[]>; // ABFC2043
  BadSet!: Set<float>; // ABFC2043

  @event
  ParamMap(m: Map<name, int>): void { // ABFC2043
    this.Size = 1;
  }

  @event
  NewMap(): void {
    const x = new Map<name, int>(); // ABFC2040
  }

  @event
  Keys(): void {
    const x = this.Counts.keys(); // ABFC2040
  }

  @event
  GetStatement(k: name): void {
    this.Counts.get(k); // ABFC2040
  }

  @event
  GetNoBang(k: name): void {
    const x = this.Counts.get(k); // ABFC2040
  }

  @event
  SetAsValue(k: name): void {
    const x = this.Counts.set(k, 1); // ABFC2099
  }

  @event
  NotOwn(other: BP_BadMaps, k: name): void {
    other.Counts.set(k, 1); // ABFC2042
  }
}
