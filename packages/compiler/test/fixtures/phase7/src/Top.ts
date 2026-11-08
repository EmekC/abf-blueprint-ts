import { blueprint, event, struct } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint()
export class TopLevel extends Actor {
  @event
  Ping(): void {}
}

@struct()
export class S_Top {
  A!: int;
}
