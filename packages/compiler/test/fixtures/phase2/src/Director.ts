import { blueprint, event, override, createWidget, spawnActor, nameOf, isValid } from "@abfc/runtime";
import type { double, int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { FakeSystem } from "/Script/FakeGame";
import { BP_FakePot_C } from "/Game/Fake/BP_FakePot";
import { WBP_Panel_C } from "/Game/Fake/WBP_Panel";
import type { BP_Director_Manual } from "/TestMod/Relay/BP_Director";

export interface BP_Director extends BP_Director_Manual {} // OwnerPC, Count, Elapsed, Label, Pots

@blueprint({ path: "/TestMod/Relay/BP_Director", replicates: true, netUpdateFrequency: 2, tickInterval: 0.1 })
export class BP_Director extends Actor {
  /** Forwards the engine tick. */
  @override
  override ReceiveTick(Delta: double): void {
    this.Step(Delta);
  }

  /** Counts the elapsed time down and bumps the counter. */
  @event
  Step(Delta: double): void {
    this.Elapsed = this.Elapsed - Delta;
    if (this.Elapsed <= 0) {
      this.Count = this.Count + 1;
      this.Announce(this.Count, this.Elapsed * 2);
    }
    if (this.Count >= 3 && this.Elapsed > 1) return;
  }

  @event
  Announce(N: int, Left: double): void {
    if (N < 1) return;
    this.Label = nameOf("None");
  }

  @event
  Start(): void {
    FakeSystem.SetTimerThing(this.Scan, 1.0);
    const panel = createWidget(WBP_Panel_C, this.OwnerPC);
    panel.SetVisibility("Collapsed");
    for (const w of FakeSystem.GetAllWidgets(WBP_Panel_C, true)) {
      if (isValid(w)) w.SetVisibility("Collapsed");
    }
  }

  @event
  Scan(): void {
    const pot = spawnActor(BP_FakePot_C, { owner: this.OwnerPC, collisionHandlingOverride: "AlwaysSpawn" });
    this.Label = nameOf("Spawned");
    pot.K2_DestroyActor();
    const first = this.Pots[0];
    if (isValid(first)) first.K2_DestroyActor();
  }
}
