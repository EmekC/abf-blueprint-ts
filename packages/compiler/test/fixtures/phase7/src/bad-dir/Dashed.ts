import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint()
export class Dashed extends Actor {
  @event
  Ping(): void {}
}
