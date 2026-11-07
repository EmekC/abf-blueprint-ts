import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint()
export class MyRelay extends Actor {
  @event
  Ping(): void {}
}
