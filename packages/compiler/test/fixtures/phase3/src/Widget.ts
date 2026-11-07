import { blueprint, event } from "@abfc/runtime";
import type { int, name, text } from "@abfc/runtime";
import { UserWidget } from "/Script/UMG";
import type { WBP_ExampleInfo_Manual } from "/TestMod/UI/WBP_ExampleInfo";
import type { WBP_ExampleRow_C } from "/TestMod/UI/WBP_ExampleRow";

export interface WBP_ExampleInfo extends WBP_ExampleInfo_Manual {}

@blueprint({ path: "/TestMod/UI/WBP_ExampleInfo", kind: "widget" })
export class WBP_ExampleInfo extends UserWidget {
  @event
  Refresh(points: int): void {
    this.Score = points;
    this.NameText.SetColorAndOpacity(1);
  }

  @event
  Label(line: text, row: WBP_ExampleRow_C): void {
    this.NameText.SetText(line);
    row.Caption.SetText(line);
  }

  @event
  Tag(name: text, hint: text): void {
    this.NameText.SetText(`+ ${name} {${hint}} ${hint}`);
  }

  @event
  Join(name: text): void {
    this.NameText.SetText(`+ ${name}`);
  }

  @event
  Quote(name: text): void {
    this.NameText.SetText(`say "${name}" \\ then
done`);
    this.NameText.SetText('He said "hi"');
  }

  @event
  Style(size: int, family: name, label: text): void {
    const Label = label;
    this.NameText.SetFont({ Size: size, Family: family, Label });
  }
}
