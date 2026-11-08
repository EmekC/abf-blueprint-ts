import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "Relays/MyRelay" })
export class Dup extends Actor {
  @event
  Ping(): void {}
}
