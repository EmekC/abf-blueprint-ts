import { blueprint, createWidget, event } from "@abfc/runtime";
import type { text } from "@abfc/runtime";
import { UserWidget } from "/Script/UMG";
import type { WBP_ExampleLine_C, WBP_ExampleLine_Manual } from "/TestMod/UI/WBP_ExampleLine";

export interface WBP_ExampleLine extends WBP_ExampleLine_Manual {}

@blueprint({ path: "/TestMod/UI/WBP_ExampleLine", kind: "widget" })
export class WBP_ExampleLine extends UserWidget {
  @event
  SetLine(Label: text, bBad: boolean): void {
    this.Caption.SetText(Label);
    if (bBad) {
      this.Caption.SetColorAndOpacity(1);
    }
  }
}

@blueprint({ path: "/TestMod/UI/WBP_ExampleHost", kind: "widget" })
export class WBP_ExampleHost extends UserWidget {
  @event
  Fill(owner: UserWidget): void {
    const line = createWidget(WBP_ExampleLine, owner);
    line.SetLine("x", true);
  }

  @event
  Retype(stub: WBP_ExampleLine_C): void {
    (stub as WBP_ExampleLine).SetLine("y", false);
  }
}
