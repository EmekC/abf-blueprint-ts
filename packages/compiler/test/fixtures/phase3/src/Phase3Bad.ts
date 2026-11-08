import { blueprint, event } from "@abfc/runtime";
import type { text } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import type { ExampleFont } from "/Script/TestCore";
import { UserWidget } from "/Script/UMG";
import type { WBP_ExampleInfo_Manual } from "/TestMod/UI/WBP_ExampleInfo";
import type { WBP_ExampleRow_C } from "/TestMod/UI/WBP_ExampleRow";
import { WBP_ExampleLine } from "./TsRefs.js";

// Every `// ABFCnnnn` marker names a diagnostic expected on that line; `@text` is where it must start (column).

@blueprint({ path: "/TestMod/UI/BP_NotAWidget", kind: "widget" })
export class BP_NotAWidget extends Actor {} // ABFC2064 @BP_NotAWidget

@blueprint({ path: "/TestMod/UI/WBP_NoKind" })
export class WBP_NoKind extends UserWidget {} // ABFC2065 @WBP_NoKind

@blueprint({ path: "/TestMod/UI/WBP_BadKind", kind: "panel" as "widget" }) // ABFC2061 @"panel" as
export class WBP_BadKind extends UserWidget {} // ABFC2065 @WBP_BadKind

export interface WBP_Clash extends WBP_ExampleInfo_Manual {}

@blueprint({ path: "/TestMod/UI/WBP_Clash", kind: "widget" })
export class WBP_Clash extends UserWidget {
  NameText!: never; // ABFC2066 @NameText
  Other = 1; // ABFC2099 @Other

  @event
  Noop(): void {}
}

export interface WBP_Subst extends WBP_ExampleInfo_Manual {}

@blueprint({ path: "/TestMod/UI/WBP_Subst", kind: "widget" })
export class WBP_Subst extends UserWidget {
  @event
  Outside(a: text): void {
    this.NameText.SetFont({ Size: 1, Family: `f ${a}`, Label: a }); // ABFC2099 @`f
  }

  @event
  Substitution(row: WBP_ExampleRow_C): void {
    this.NameText.SetText(`v ${row}`); // ABFC2099 @row}
  }

  @event
  Members(other: ExampleFont): void {
    this.NameText.SetFont({ Size: 1, ...other }); // ABFC2099 @...other
  }

  @event
  NotAStruct(): void {
    const o = { Size: 1 }; // ABFC2099 @{ Size: 1 }
  }
}

@blueprint({ path: "/TestMod/UI/WBP_ExampleChild", kind: "widget" })
export class WBP_ExampleChild extends WBP_ExampleLine {} // ABFC2060 @WBP_ExampleLine

@blueprint({ path: "/TestMod/UI/WBP_ExampleRetype", kind: "widget" })
export class WBP_ExampleRetype extends UserWidget {
  @event
  Wrong(row: WBP_ExampleRow_C): void {
    (row as WBP_ExampleLine).SetLine("z", false); // ABFC2099 @row as
  }
}
