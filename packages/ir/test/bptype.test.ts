import { test } from "node:test";
import assert from "node:assert/strict";
import { BpTypeError, bpTypeFromPin, parseBpType, pinObjectText, validateIrModule, renderT3D } from "../src/index.js";
import type { IrModule, IrNode, Span } from "../src/index.js";

const span: Span = { file: "a.ts", line: 1, col: 1, endLine: 1, endCol: 2 };

/** Grammar string -> parsed -> pin-like record -> grammar string. */
function roundTrip(t: string): string {
  const p = parseBpType(t);
  const obj = p.path;
  return bpTypeFromPin({ category: p.cat, subCategory: p.sub, subCategoryObject: obj, container: p.container });
}

test("grammar round trip for every simple type", () => {
  for (const t of ["bool", "byte", "int", "int64", "name", "string", "text", "float", "real"]) {
    assert.equal(roundTrip(t), t, t);
  }
  assert.equal(roundTrip("double"), "real");
});

test("grammar round trip for path types and arrays", () => {
  for (const t of [
    "object:/Script/Engine.Actor",
    "class:/Script/Engine.Actor",
    "softobject:/Script/Engine.Actor",
    "softclass:/Script/Engine.Actor",
    "interface:/Script/Fake.Iface",
    "struct:/Script/Fake.Pair",
    "enum:/Script/Fake.Kind",
    "array:object:/Script/Engine.Actor",
    "array:name",
    "array:struct:/Script/Fake.Pair",
    "array:enum:/Script/Fake.Kind",
  ]) {
    assert.equal(roundTrip(t), t, t);
  }
});

test("parseBpType fields", () => {
  assert.deepEqual(parseBpType("real"), { cat: "real", sub: "double", path: null, container: "None" });
  assert.deepEqual(parseBpType("float"), { cat: "real", sub: "float", path: null, container: "None" });
  assert.deepEqual(parseBpType("enum:/Script/Fake.Kind"), { cat: "byte", sub: "", path: "/Script/Fake.Kind", container: "None" });
  assert.deepEqual(parseBpType("array:object:/Script/Engine.Actor"), {
    cat: "object", sub: "", path: "/Script/Engine.Actor", container: "Array",
  });
});

test("parseBpType refusals", () => {
  for (const t of ["", "  ", "array:array:int", "set:int", "map:name:int", "object", "struct:", "wibble", "object: "]) {
    assert.throws(() => parseBpType(t), BpTypeError, JSON.stringify(t));
  }
  assert.throws(() => bpTypeFromPin({ category: "delegate", subCategory: "", subCategoryObject: null, container: "None" }), BpTypeError);
  assert.throws(() => bpTypeFromPin({ category: "int", subCategory: "", subCategoryObject: null, container: "Map" }), BpTypeError);
});

test("bpTypeFromPin maps real/float and byte", () => {
  const pin = (category: string, subCategory = "", subCategoryObject: string | null = null, container = "None") =>
    ({ category, subCategory, subCategoryObject, container });
  assert.equal(bpTypeFromPin(pin("real", "float")), "float");
  assert.equal(bpTypeFromPin(pin("real", "double")), "real");
  assert.equal(bpTypeFromPin(pin("byte")), "byte");
  assert.equal(bpTypeFromPin(pin("byte", "", "/Script/Fake.Kind", "Array")), "array:enum:/Script/Fake.Kind");
});

test("pinObjectText", () => {
  const widgetClass = "/Fake/Mod/WBP_Thing.WBP_Thing_C";
  const meta = { [widgetClass]: "/Script/UMG.WidgetBlueprintGeneratedClass" };
  assert.equal(pinObjectText("object", "/Script/Engine.Actor", meta), "/Script/CoreUObject.Class'/Script/Engine.Actor'");
  assert.equal(pinObjectText("object", widgetClass, meta), `/Script/UMG.WidgetBlueprintGeneratedClass'${widgetClass}'`);
  assert.equal(pinObjectText("class", "/Fake/Mod/BP_Plain.BP_Plain_C", meta), "/Script/Engine.BlueprintGeneratedClass'/Fake/Mod/BP_Plain.BP_Plain_C'");
  assert.equal(pinObjectText("struct", "/Script/Fake.Pair", meta), "/Script/CoreUObject.ScriptStruct'/Script/Fake.Pair'");
  assert.equal(pinObjectText("struct", "/Fake/Mod/S_Pair.S_Pair", meta), "/Script/Engine.UserDefinedStruct'/Fake/Mod/S_Pair.S_Pair'");
  assert.equal(pinObjectText("enum", "/Script/Fake.Kind", meta), "/Script/CoreUObject.Enum'/Script/Fake.Kind'");
  assert.equal(pinObjectText("enum", "/Fake/Mod/E_Kind.E_Kind", meta), "/Script/Engine.UserDefinedEnum'/Fake/Mod/E_Kind.E_Kind'");
});

function node(id: string, extra: Partial<IrNode> = {}): IrNode {
  return { id, t3d: { class: "/Script/Fake.Node", props: ["Foo=1"] }, pos: [0, 0], origin: span, ...extra };
}

test("validateIrModule", () => {
  const unit = (nodes: IrNode[], wires: Array<[`${string}.${string}`, `${string}.${string}`]>) => ({
    id: "event:Go", kind: "event" as const, name: "Go", graph: "EventGraph",
    signature: { inputs: [], outputs: [] }, locals: [], nodes, wires, origin: span, hash: "",
  });
  const mod = (u: ReturnType<typeof unit>, path = "/Mod/BP_A"): IrModule => ({
    irVersion: 1, profile: "p", mod: "Mod", classMeta: {},
    assets: [{ path, variables: [], units: [u] }],
  });
  assert.deepEqual(validateIrModule(mod(unit([node("a1"), node("b2")], [["a1.then", "b2.execute"], ["entry.then", "a1.execute"]]))), []);
  assert.equal(validateIrModule(mod(unit([node("a1")], [["a1.then", "zz.execute"]]))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("a1"), node("a1")], []))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("entry")], []))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("1bad")], []))).length, 1);
  assert.equal(validateIrModule(mod(unit([node("a1")], []), "/Other/BP_A")).length, 1);
  assert.equal(validateIrModule(mod(unit([node("a1", { pinTypes: { Object: "map:name:int" } })], []))).length, 1);
  assert.deepEqual(validateIrModule(mod(unit([node("a1", { pinTypes: { Object: "object:/Script/Engine.Actor" } })], []))), []);
});

test("renderT3D", () => {
  const text = renderT3D(node("a1", { pos: [10.4, -20.6] }), "Fake_Node_0", "0123456789ABCDEF0123456789ABCDEF");
  assert.equal(
    text,
    [
      'Begin Object Class=/Script/Fake.Node Name="Fake_Node_0"',
      "   Foo=1",
      "   NodePosX=10",
      "   NodePosY=-21",
      "   NodeGuid=0123456789ABCDEF0123456789ABCDEF",
      "End Object",
    ].join("\n"),
  );
  assert.match(renderT3D(node("a1"), "N"), /NodeGuid=[0-9A-F]{32}\nEnd Object$/);
});
