import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLayout, layoutRegion } from "../src/index.js";

const ASSET = "/TestMod/UI/WBP_ExampleInfo";

interface Opts {
  eventNode?: string;
  treeProp?: string;
  vars?: string[];
  crlf?: boolean;
}

function newVar(index: number, name: string, def = ""): string {
  return (
    `   NewVariables(${index})=(VarName="${name}",VarGuid=00000000000000000000000000000001,` +
    `VarType=(PinCategory="struct",PinSubCategory="",PinSubCategoryObject=None,ContainerType=None,bIsReference=False),` +
    `FriendlyName="${name}",DefaultValue="${def}",PropertyFlags=4,Category=NSLOCTEXT("", "A", "Default"))`
  );
}

/** Synthetic Widget Blueprint export: WidgetTree (declaration + definition), two EdGraphs, bookkeeping and variables. */
function fakeExport(o: Opts = {}): string {
  const vars = o.vars ?? ["BodyFont"];
  const lines = [
    `Begin Object Class=/Script/UMG.WidgetBlueprint Name="WBP_ExampleInfo" ExportPath="/Script/UMG.WidgetBlueprint'${ASSET}.WBP_ExampleInfo'"`,
    `   Begin Object Class=/Script/UMG.WidgetTree Name="WidgetTree" ExportPath="/Script/UMG.WidgetTree'${ASSET}:WidgetTree'"`,
    `      Begin Object Class=/Script/UMG.TextBlock Name="NameText" ExportPath="/Script/UMG.TextBlock'${ASSET}:WidgetTree.NameText'"`,
    `      End Object`,
    `      Begin Object Class=/Script/UMG.TextBlock Name="StatsText" ExportPath="/Script/UMG.TextBlock'${ASSET}:WidgetTree.StatsText'"`,
    `      End Object`,
    `   End Object`,
    `   Begin Object Class=/Script/Engine.EdGraph Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${ASSET}:EventGraph'"`,
    `   End Object`,
    `   Begin Object Name="WidgetTree" ExportPath="/Script/UMG.WidgetTree'${ASSET}:WidgetTree'"`,
    `      Begin Object Name="NameText" ExportPath="/Script/UMG.TextBlock'${ASSET}:WidgetTree.NameText'"`,
    `         Text=NSLOCTEXT("", "K1", "Name")`,
    `         bIsVariable=True`,
    `      End Object`,
    `      Begin Object Name="StatsText" ExportPath="/Script/UMG.TextBlock'${ASSET}:WidgetTree.StatsText'"`,
    `         ${o.treeProp ?? 'Text=NSLOCTEXT("", "K2", "Stats")'}`,
    `         bIsVariable=True`,
    `      End Object`,
    `      RootWidget="/Script/UMG.TextBlock'${ASSET}:WidgetTree.NameText'"`,
    `   End Object`,
    `   Begin Object Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${ASSET}:EventGraph'"`,
    `      Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0" ExportPath="/Script/BlueprintGraph.K2Node_CustomEvent'${ASSET}:EventGraph.K2Node_CustomEvent_0'"`,
    `      End Object`,
    `      Begin Object Name="K2Node_CustomEvent_0" ExportPath="/Script/BlueprintGraph.K2Node_CustomEvent'${ASSET}:EventGraph.K2Node_CustomEvent_0'"`,
    `         CustomFunctionName="${o.eventNode ?? "ShowInfo"}"`,
    `      End Object`,
    `      Schema="/Script/CoreUObject.Class'/Script/UnrealEd.EdGraphSchema_K2'"`,
    `   End Object`,
    `   ParentClass="/Script/CoreUObject.Class'/Script/UMG.UserWidget'"`,
    `   UbergraphPages(0)="/Script/Engine.EdGraph'${ASSET}:EventGraph'"`,
    `   FunctionGraphs(0)="/Script/Engine.EdGraph'${ASSET}:ShowInfo'"`,
    ...vars.map((v, k) => newVar(k, v)),
    `   LastEditedDocuments(0)=(EditedObjectPath="/Script/Engine.EdGraph'${ASSET}:EventGraph'")`,
    `   bLegacyNeedToPurgeSkelRefs=True`,
    `End Object`,
    ``,
  ];
  return lines.join(o.crlf ? "\r\n" : "\n");
}

test("layoutRegion drops EdGraph blocks and graph lists but keeps the WidgetTree", () => {
  const region = layoutRegion(fakeExport());
  const text = region.join("\n");
  assert.ok(text.includes('Begin Object Class=/Script/UMG.WidgetTree Name="WidgetTree"'));
  assert.ok(text.includes('Begin Object Name="WidgetTree"'));
  assert.ok(text.includes("bIsVariable=True"));
  assert.ok(text.includes("bLegacyNeedToPurgeSkelRefs=True"));
  assert.ok(!text.includes("EdGraph"));
  assert.ok(!text.includes("K2Node_CustomEvent"));
  assert.ok(!text.includes("UbergraphPages"));
  assert.ok(!text.includes("FunctionGraphs"));
  assert.ok(!text.includes("LastEditedDocuments"));
  assert.ok(region.some((l) => l.startsWith("   NewVariables=(VarName=\"BodyFont\"")));
});

test("a change inside a graph keeps the layout equal", () => {
  const d = diffLayout(fakeExport(), fakeExport({ eventNode: "ShowInfoAgain" }));
  assert.equal(d.equal, true);
  assert.equal(d.firstDiff, undefined);
});

test("a WidgetTree property change is a difference", () => {
  const d = diffLayout(fakeExport(), fakeExport({ treeProp: 'Text=NSLOCTEXT("", "K2", "Changed")' }));
  assert.equal(d.equal, false);
  assert.ok(d.firstDiff?.before.includes("Stats"));
  assert.ok(d.firstDiff?.after.includes("Changed"));
});

test("an added owned variable is equal only when declared owned", () => {
  const before = fakeExport();
  const after = fakeExport({ vars: ["BodyFont", "Counter"] });
  assert.equal(diffLayout(before, after, ["Counter"]).equal, true);
  assert.equal(diffLayout(before, after).equal, false);
});

test("compiler temporaries abfc_* never count", () => {
  assert.equal(diffLayout(fakeExport(), fakeExport({ vars: ["BodyFont", "abfc_i_0"] })).equal, true);
});

test("a changed or removed non-owned variable is a difference", () => {
  const before = fakeExport({ vars: ["BodyFont", "BoldFont"] });
  assert.equal(diffLayout(before, fakeExport({ vars: ["BodyFont", "OtherFont"] }), ["Counter"]).equal, false);
  assert.equal(diffLayout(before, fakeExport({ vars: ["BodyFont"] })).equal, false);
});

test("owned variables do not renumber the remaining ones", () => {
  const before = fakeExport({ vars: ["Counter", "BodyFont"] });
  const after = fakeExport({ vars: ["BodyFont"] });
  assert.equal(diffLayout(before, after, ["Counter"]).equal, true);
});

test("CRLF and LF exports compare equal", () => {
  assert.equal(diffLayout(fakeExport({ crlf: true }), fakeExport()).equal, true);
});

test("diffLayout reports line counts", () => {
  const d = diffLayout(fakeExport(), fakeExport());
  assert.equal(d.beforeLines, d.afterLines);
  assert.ok(d.beforeLines > 10);
});

test("sibling widget order does not matter, but a changed child does", () => {
  const swap = (text: string): string => {
    const lines = text.split("\n");
    const find = (needle: string, from = 0): number => lines.findIndex((l, k) => k >= from && l.includes(needle));
    const swapBlocks = (a: string, b: string, from: number, size: number): void => {
      const i = find(a, from);
      const j = find(b, from);
      const first = lines.slice(i, i + size);
      const second = lines.slice(j, j + size);
      lines.splice(j, size, ...first);
      lines.splice(i, size, ...second);
    };
    swapBlocks('Name="NameText"', 'Name="StatsText"', 0, 2);
    const def = find('Begin Object Name="WidgetTree"');
    swapBlocks('Name="NameText"', 'Name="StatsText"', def, 4);
    return lines.join("\n");
  };
  const base = fakeExport();
  const swapped = swap(base);
  assert.notEqual(swapped, base);
  assert.equal(diffLayout(base, swapped).equal, true);
  assert.equal(diffLayout(base, swapped, [], { sortSiblings: false }).equal, false, "strict mode keeps the export order");
  assert.equal(diffLayout(base, base, [], { sortSiblings: false }).equal, true);
  assert.equal(diffLayout(base, swap(fakeExport({ treeProp: 'Text=NSLOCTEXT("", "K2", "Changed")' }))).equal, false);
});
