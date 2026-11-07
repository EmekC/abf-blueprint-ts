import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "Other/Kept" })
export class Rel extends Actor {
  @event
  Ping(): void {}
}

@blueprint({ path: "/TestMod/Moved/Abs" })
export class Abs extends Actor {
  @event
  Ping(): void {}
}

@blueprint({ path: "Same" })
export class Same extends Actor {
  @event
  Ping(): void {}
}

@blueprint({ path: "/OtherMod/X" })
export class Foreign extends Actor {
  @event
  Ping(): void {}
}
