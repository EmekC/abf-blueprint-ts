import { blueprint, event, cast, isValid } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { FakeLibrary as Lib } from "/Script/FakeGame";
import { BP_FakeCharacter_C } from "/Game/Fake/BP_FakeCharacter";
import { BP_FakePot_C } from "/Game/Fake/BP_FakePot";
import type { BP_Relay_Manual } from "/TestMod/Relay/BP_Relay";

export interface BP_Relay extends BP_Relay_Manual {} // OwnerPC, LastTarget, LastName, Widgets, Visible, HideAll

@blueprint({ path: "/TestMod/Relay/BP_Relay" })
export class BP_Relay extends Actor {
  @event
  UpdateTarget(): void {
    const player = cast(this.OwnerPC?.GetPawnThing(), BP_FakeCharacter_C);
    const pot = cast(player?.Target, BP_FakePot_C);
    if (!pot || !pot.Ready) {
      this.HideAll();
      this.LastTarget = null;
      return;
    }
    const rowName = Lib.RowToName(pot.Row);
    if (pot === this.LastTarget && rowName === this.LastName) return;
    this.LastTarget = pot;
    this.LastName = rowName;
    const row = Lib.GetRow(pot.Row);
    if (row.exec !== "Valid") {
      this.HideAll();
      return;
    }
    const info = row.Data.Info;
    if (info.A === 0 && info.B === 0 && info.List.length === 0) {
      this.HideAll();
      return;
    }
    for (const w of this.Widgets) {
      if (isValid(w)) w.Show(info.A, info.B, info.List, true);
    }
    this.Visible = true;
  }
}
