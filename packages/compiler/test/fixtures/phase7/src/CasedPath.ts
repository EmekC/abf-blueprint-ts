import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/testmod/Cased/CasedAbs" })
export class CasedAbs extends Actor {
  @event
  Ping(): void {}
}
