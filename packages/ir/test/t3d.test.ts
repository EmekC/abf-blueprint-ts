import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PatchError, extractGraphBlock, parseAttrs, parseExport, patchWildcardPins, pinName, unitStateHash, userPins,
} from "../src/index.js";

const WIDGET = "/Fake/Mod/WBP_Thing.WBP_Thing_C";
const BP = "/Fake/Mod/BP_Host.BP_Host";
const WILD = 'PinType.PinCategory="wildcard",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None';

function pin(id: string, name: string, opts: { out?: boolean; type?: string; container?: string; def?: string; links?: string } = {}): string {
  const type = opts.type ?? 'PinType.PinCategory="exec",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None';
  return (
    `CustomProperties Pin (PinId=${id},PinName="${name}"${opts.out ? ',Direction="EGPD_Output"' : ""},${type},` +
    `PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=(),PinType.ContainerType=${opts.container ?? "None"},` +
    "PinType.bIsReference=False" +
    (opts.def !== undefined ? `,DefaultValue="${opts.def}"` : "") +
    (opts.links ? `,LinkedTo=(${opts.links})` : "") +
    ",PersistentGuid=00000000000000000000000000000000,bHidden=False,)"
  );
}

interface Opts { posX?: number; ev1Id?: string; def?: string; link?: string; guid?: string }

/** Synthetic export: stub block + body block per graph, as the engine writes it. */
function fakeExport(o: Opts = {}): string {
  const evId = o.ev1Id ?? "AAAA0000000000000000000000000001";
  const guid = o.guid ?? "11111111111111111111111111111111";
  const link = o.link ?? "Fake_Cast_0 CCCC0000000000000000000000000001";
  const obj = `/Script/CoreUObject.Class'/Script/Engine.Actor'`;
  const lines = [
    `Begin Object Class=/Script/Engine.Blueprint Name="BP_Host" ExportPath="/Script/Engine.Blueprint'${BP}'"`,
    `   Begin Object Class=/Script/Engine.EdGraph Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${BP}:EventGraph'"`,
    `      Begin Object Class=/Script/Fake.Widget Name="Fake_Event_0" ExportPath="/Script/Fake.Widget'${BP}:EventGraph.Fake_Event_0'"`,
    "      End Object",
    `      Begin Object Class=/Script/Fake.Widget Name="Fake_Cast_0" ExportPath="/Script/Fake.Widget'${BP}:EventGraph.Fake_Cast_0'"`,
    "      End Object",
    "   End Object",
    `   Begin Object Class=/Script/Engine.EdGraph Name="OtherGraph" ExportPath="/Script/Engine.EdGraph'${BP}:OtherGraph'"`,
    `      Begin Object Class=/Script/Fake.Widget Name="Fake_Event_0" ExportPath="/Script/Fake.Widget'${BP}:OtherGraph.Fake_Event_0'"`,
    "      End Object",
    "   End Object",
    `   Begin Object Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${BP}:EventGraph'"`,
    `      Begin Object Name="Fake_Event_0" ExportPath="/Script/Fake.Widget'${BP}:EventGraph.Fake_Event_0'"`,
    '         FunctionReference=(MemberParent="/Script/Fake.Widget",MemberName="Go",MemberGuid=ABCDEF0123456789ABCDEF0123456789)',
    `         NodePosX=${o.posX ?? 0}`,
    "         NodePosY=0",
    `         NodeGuid=${guid}`,
    '         CustomProperties UserDefinedPin (PinName="DeltaSeconds",PinType=(PinCategory="real",PinSubCategory="float"),DesiredPinDirection=EGPD_Output)',
    '         CustomProperties UserDefinedPin (PinName="Target",PinType=(PinCategory="object",PinSubCategoryObject="' + obj + '"),DesiredPinDirection=EGPD_Input)',
    "         " + pin(evId, "then", { out: true, links: link }),
    "      End Object",
    `      Begin Object Name="Fake_Cast_0" ExportPath="/Script/Fake.Widget'${BP}:EventGraph.Fake_Cast_0'"`,
    "         " + pin("CCCC0000000000000000000000000001", "execute", { links: "Fake_Event_0 " + evId }),
    "         " + pin("CCCC0000000000000000000000000002", "Object", { type: WILD, def: o.def ?? "" }),
    "         " + pin("CCCC0000000000000000000000000003", "Items", { type: WILD, container: "Array" }),
    "         " + pin("CCCC0000000000000000000000000004", "Other", { type: WILD }),
    "      End Object",
    "   End Object",
    `   Begin Object Name="OtherGraph" ExportPath="/Script/Engine.EdGraph'${BP}:OtherGraph'"`,
    `      Begin Object Name="Fake_Event_0" ExportPath="/Script/Fake.Widget'${BP}:OtherGraph.Fake_Event_0'"`,
    "         " + pin("DDDD0000000000000000000000000001", "then", { out: true }),
    "      End Object",
    "   End Object",
    `   ParentClass="/Script/CoreUObject.Class'/Script/Engine.Actor'"`,
    `   NewVariables(0)=(VarName="Infos",VarGuid=580FEBBD48029499A06ECAB0E5B35EF0,VarType=(PinCategory="object",PinSubCategoryObject="/Script/UMG.WidgetBlueprintGeneratedClass'${WIDGET}'",ContainerType=Array),FriendlyName="Infos",PropertyFlags=65541)`,
    `   NewVariables(1)=(VarName="Last",VarGuid=B9A5CF56484DE0E7DDD1D99A685F371C,VarType=(PinCategory="name"),FriendlyName="Last",PropertyFlags=65541,DefaultValue="None")`,
    `   NewVariables(2)=(VarName="Scale",VarGuid=B9A5CF56484DE0E7DDD1D99A685F371D,VarType=(PinCategory="real",PinSubCategory="float"),FriendlyName="Scale",PropertyFlags=65541)`,
    "End Object",
    "",
  ];
  return lines.join("\r\n");
}

test("a quoted variable default is unescaped (FText with quotes and a backslash)", () => {
  const text = [
    `Begin Object Class=/Script/UnrealEd.Foo Name="Foo_0" ExportPath=/Script/UnrealEd.Foo'/Temp/X.X:Foo_0'`,
    `   NewVariables(0)=(VarName="Label",VarGuid=B9A5CF56484DE0E7DDD1D99A685F371C,VarType=(PinCategory="text"),FriendlyName="Label",PropertyFlags=65541,DefaultValue="NSLOCTEXT(\\"ns\\", \\"k\\", \\"a\\\\b\\")")`,
    `End Object`,
  ].join("\n");
  const v = parseExport(text).variables.find((x) => x.name === "Label");
  assert.equal(v?.default, `NSLOCTEXT("ns", "k", "a\\b")`);
});

test("parseAttrs respects quotes and parentheses", () => {
  const a = parseAttrs('A=1,B="x,y",C=(p=1,q="2)"),D=');
  assert.deepEqual(a, { A: "1", B: '"x,y"', C: '(p=1,q="2)")', D: "" });
});

test("parseExport reads nodes, graphs, pins and links", () => {
  const e = parseExport(fakeExport());
  assert.equal(e.parentClass, "/Script/Engine.Actor");
  const ev = e.nodes.get("Fake_Event_0")!;
  assert.equal(ev.cls, "/Script/Fake.Widget");
  assert.equal(ev.graph, "EventGraph");
  assert.equal(ev.pins.length, 1);
  assert.equal(ev.pins[0]!.name, "then");
  assert.equal(ev.pins[0]!.dir, "out");
  assert.deepEqual(ev.pins[0]!.links, [{ node: "Fake_Cast_0", pinId: "CCCC0000000000000000000000000001" }]);
  const cast = e.nodes.get("Fake_Cast_0")!;
  assert.equal(cast.pins.length, 4);
  assert.equal(cast.pins[1]!.category, "wildcard");
  assert.equal(cast.pins[1]!.defaultValue, "");
  assert.equal(cast.pins[2]!.container, "Array");
  assert.equal(pinName(ev, "AAAA0000000000000000000000000001"), "then");
  assert.equal(pinName(ev, "nope"), null);
  // same node name in another graph is kept under a qualified key
  assert.equal(e.nodes.get("OtherGraph/Fake_Event_0")?.graph, "OtherGraph");
  assert.equal(e.nodes.get("OtherGraph/Fake_Event_0")?.name, "Fake_Event_0");
  assert.equal(e.nodes.size, 3);
});

test("parseExport keeps plain node keys for the event graph whatever the graph order is", () => {
  const graph = (name: string, node: string): string[] => [
    `   Begin Object Class=/Script/Engine.EdGraph Name="${name}" ExportPath="/Script/Engine.EdGraph'${BP}:${name}'"`,
    `      Begin Object Class=/Script/Fake.Widget Name="${node}" ExportPath="/Script/Fake.Widget'${BP}:${name}.${node}'"`,
    "      End Object",
    "   End Object",
  ];
  const head = `Begin Object Class=/Script/Engine.Blueprint Name="BP_Host" ExportPath="/Script/Engine.Blueprint'${BP}'"`;
  const make = (order: string[]): string =>
    [head, ...order.flatMap((g) => graph(g, "Fake_Call_0")), "End Object"].join("\n");
  for (const order of [["EventGraph", "Stub"], ["Stub", "EventGraph"], ["StubA", "EventGraph", "StubB"]]) {
    const e = parseExport(make(order));
    assert.equal(e.nodes.get("Fake_Call_0")?.graph, "EventGraph", order.join(","));
    for (const g of order.filter((x) => x !== "EventGraph")) assert.equal(e.nodes.get(`${g}/Fake_Call_0`)?.graph, g);
    assert.equal(e.nodes.size, order.length);
  }
  // without an event graph the first graph in the file keeps the plain key
  assert.equal(parseExport(make(["StubA", "StubB"])).nodes.get("Fake_Call_0")?.graph, "StubA");
});

test("parseExport reads variables and entry pins", () => {
  const e = parseExport(fakeExport());
  assert.deepEqual(e.variables, [
    { name: "Infos", type: `array:object:${WIDGET}`, default: null, propertyFlags: "65541" },
    { name: "Last", type: "name", default: "None", propertyFlags: "65541" },
    { name: "Scale", type: "float", default: null, propertyFlags: "65541" },
  ]);
  const up = userPins(e.nodes.get("Fake_Event_0")!);
  assert.deepEqual(up.outs, [{ name: "DeltaSeconds", type: "float" }]);
  assert.deepEqual(up.ins, [{ name: "Target", type: "object:/Script/Engine.Actor" }]);
});

test("extractGraphBlock returns the inner lines without ExportPath", () => {
  const block = extractGraphBlock(fakeExport(), "EventGraph");
  assert.ok(block.includes('Begin Object Name="Fake_Cast_0"'));
  assert.ok(block.includes('Begin Object Class=/Script/Fake.Widget Name="Fake_Cast_0"'));
  assert.ok(!block.includes("ExportPath"));
  assert.ok(!block.includes("\r"));
  assert.ok(!block.includes("OtherGraph"));
  assert.throws(() => extractGraphBlock(fakeExport(), "Missing"), /not found/);
});

test("patchWildcardPins patches two pins and counts them", () => {
  const block = extractGraphBlock(fakeExport(), "EventGraph");
  const meta = { [WIDGET]: "/Script/UMG.WidgetBlueprintGeneratedClass" };
  const r = patchWildcardPins(block, [
    { node: "Fake_Cast_0", pin: "Object", type: "object:/Script/CoreUObject.Object" },
    { node: "Fake_Cast_0", pin: "Items", type: `array:object:${WIDGET}` },
  ], meta);
  assert.equal(r.patched, 2);
  assert.ok(r.text.includes(
    `PinType.PinCategory="object",PinType.PinSubCategory="",PinType.PinSubCategoryObject="/Script/CoreUObject.Class'/Script/CoreUObject.Object'"`,
  ));
  assert.ok(r.text.includes(`PinType.PinSubCategoryObject="/Script/UMG.WidgetBlueprintGeneratedClass'${WIDGET}'"`));
  // the unpatched wildcard pin is untouched
  assert.equal([...r.text.matchAll(/PinCategory="wildcard"/g)].length, 1);
  // a patch for an unknown node or pin patches nothing
  assert.equal(patchWildcardPins(block, [{ node: "Nope", pin: "Object", type: "int" }], meta).patched, 0);
});

test("patchWildcardPins refuses a container mismatch", () => {
  const block = extractGraphBlock(fakeExport(), "EventGraph");
  assert.throws(() => patchWildcardPins(block, [{ node: "Fake_Cast_0", pin: "Items", type: "int" }], {}), PatchError);
  assert.throws(() => patchWildcardPins(block, [{ node: "Fake_Cast_0", pin: "Object", type: "array:int" }], {}), PatchError);
});

function hashOf(o: Opts): string {
  const e = parseExport(fakeExport(o));
  return unitStateHash(e.nodes, ["Fake_Event_0", "Fake_Cast_0"]);
}

test("unitStateHash ignores positions, guids and pin ids", () => {
  const base = hashOf({});
  assert.match(base, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hashOf({ posX: 777 }), base);
  assert.equal(hashOf({ guid: "22222222222222222222222222222222" }), base);
  // the event's pin id changes, and the cast's link to it still resolves to the same pin name
  const e = fakeExport({ ev1Id: "EEEE0000000000000000000000000009" });
  assert.equal(unitStateHash(parseExport(e).nodes, ["Fake_Event_0", "Fake_Cast_0"]), base);
});

test("unitStateHash changes with a default or a link, and flags missing nodes", () => {
  const base = hashOf({});
  assert.notEqual(hashOf({ def: "changed" }), base);
  assert.notEqual(hashOf({ link: "" }), base);
  const e = parseExport(fakeExport());
  assert.notEqual(unitStateHash(e.nodes, ["Fake_Event_0", "Fake_Cast_0", "Gone"]), base);
  assert.notEqual(unitStateHash(e.nodes, ["Gone"]), unitStateHash(e.nodes, ["Fake_Event_0"]));
});

test("map and set variables, pins and user pins parse to grammar types with their value type", () => {
  const mapPin = (id: string, name: string, value: string): string =>
    `CustomProperties Pin (PinId=${id},PinName="${name}",PinType.PinCategory="name",PinType.PinSubCategory="",PinType.PinSubCategoryObject=None,` +
    `PinType.PinSubCategoryMemberReference=(),PinType.PinValueType=${value},PinType.ContainerType=Map,PinType.bIsReference=False,` +
    "PersistentGuid=00000000000000000000000000000000,bHidden=False,)";
  const text = [
    `Begin Object Class=/Script/Engine.Blueprint Name="BP_Host" ExportPath="/Script/Engine.Blueprint'${BP}'"`,
    `   NewVariables(0)=(VarName="Counts",VarGuid=4F1E9FD0FD104258BE5D5D30A551C609,VarType=(PinCategory="name",PinValueType=(TerminalCategory="int"),ContainerType=Map),FriendlyName="Counts",PropertyFlags=5)`,
    `   NewVariables(1)=(VarName="Tags",VarGuid=4F1E9FD0FD104258BE5D5D30A551C60A,VarType=(PinCategory="name",ContainerType=Set),FriendlyName="Tags",PropertyFlags=5)`,
    `   NewVariables(2)=(VarName="Refs",VarGuid=4F1E9FD0FD104258BE5D5D30A551C60B,VarType=(PinCategory="string",PinValueType=(TerminalCategory="object",TerminalSubCategoryObject="/Script/CoreUObject.Class'/Script/Engine.Actor'"),ContainerType=Map),FriendlyName="Refs",PropertyFlags=5)`,
    `   NewVariables(3)=(VarName="Broken",VarGuid=4F1E9FD0FD104258BE5D5D30A551C60C,VarType=(PinCategory="name",ContainerType=Map),FriendlyName="Broken",PropertyFlags=5)`,
    `   Begin Object Class=/Script/Engine.EdGraph Name="EventGraph" ExportPath="/Script/Engine.EdGraph'${BP}:EventGraph'"`,
    `      Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_0" ExportPath="/Script/BlueprintGraph.K2Node_CallFunction'${BP}:EventGraph.K2Node_CallFunction_0'"`,
    "         " + mapPin("DDDD0000000000000000000000000001", "TargetMap", '(TerminalCategory="int")'),
    "         " + mapPin("DDDD0000000000000000000000000002", "Empty", "()"),
    '         CustomProperties UserDefinedPin (PinName="Lookup",PinType=(PinCategory="name",PinValueType=(TerminalCategory="int"),ContainerType=Map),DesiredPinDirection=EGPD_Input)',
    "      End Object",
    "   End Object",
    "End Object",
  ].join("\n");
  const ex = parseExport(text);
  assert.deepEqual(ex.variables.map((v) => v.type), ["map:name:int", "set:name", "map:string:object:/Script/Engine.Actor", "unsupported:name:Map"]);
  const node = ex.nodes.get("K2Node_CallFunction_0")!;
  assert.deepEqual(node.pins[0]!.valueType, { category: "int", subCategory: "", subCategoryObject: null });
  assert.equal(node.pins[0]!.container, "Map");
  assert.equal(node.pins[1]!.valueType, null);
  assert.deepEqual(userPins(node).ins, [{ name: "Lookup", type: "map:name:int" }]);
  // a map pin's value type stays out of the semantic hash, so units applied before value types were parsed keep their stored hash
  const other = parseExport(text.replace('PinType.PinValueType=(TerminalCategory="int"),PinType.ContainerType=Map', 'PinType.PinValueType=(TerminalCategory="bool"),PinType.ContainerType=Map'));
  assert.equal(unitStateHash(ex.nodes, ["K2Node_CallFunction_0"]), unitStateHash(other.nodes, ["K2Node_CallFunction_0"]));
});
