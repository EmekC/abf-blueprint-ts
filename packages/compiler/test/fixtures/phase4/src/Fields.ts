import { blueprint, event } from "@abfc/runtime";
import type { int, name } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

// Every `// ABFCnnnn` marker names a diagnostic expected on that line.

@blueprint({ path: "/TestMod/Phase4/BP_Fields" })
export class BP_Fields extends Actor {
  Score!: int;
  Counts!: Map<name, int>;
  Seen!: Set<name>;
  Names!: name[];
  Bad1: int = 1 + 2; // ABFC2047
  readonly Bad2!: int; // ABFC2047
  Bad3?: int; // ABFC2047
  Bad4!: number; // ABFC2047
  Bad5!: Map<boolean, int>; // ABFC2043

  @event
  Bump(by: int): void {
    this.Score = by;
    this.Names.push("a" as name);
  }
}
