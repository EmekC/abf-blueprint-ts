// D3: writes spike/out/p3/UpdateTarget.ir.json (the design 4.3 lowering of UpdateTarget as an IrModule).
// Node text (t3d.props) is copied from same-member nodes of the reference export (EventGraph), so it is the engine's own text.
// refNode = spike-only field: reference node used for t3d props and (in check_ir.mjs) for pin names.
import fs from "node:fs";
const REF = "spike/out/ref/BP_SoupInfoRelay.export.t3d";
const lines = fs.readFileSync(REF, "utf8").split(/\r?\n/);
const refs = new Map(); // EventGraph node name -> {cls, props}
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*Begin Object Name="([^"]+)" ExportPath="([^']*)'([^']*)'/);
  if (!m || !/:EventGraph\.[^.]+$/.test(m[3])) continue;
  const props = [];
  for (i++; i < lines.length && !/^\s*End Object/.test(lines[i]); i++) {
    const l = lines[i].trim();
    if (l.startsWith("CustomProperties Pin (") || l.startsWith("Begin Object")) continue;
    if (/^(NodePosX|NodePosY|NodeGuid|ErrorType|ErrorMsg|bCommentBubble)/.test(l)) continue;
    props.push(l);
  }
  refs.set(m[1], { cls: m[2], props });
}
const PLAYER = "/Game/Blueprints/Characters/Abiotic_PlayerCharacter.Abiotic_PlayerCharacter_C";
const POT = "/Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup.Deployed_PotOfSoup_C";
const SOUP = "/goodsoupWagdD/SoupInfo/WBP_SoupInfo.WBP_SoupInfo_C";
const KSL = "/Script/Engine.KismetSystemLibrary", KML = "/Script/Engine.KismetMathLibrary", GIH = "/Script/AbioticFactor.GlobalItemHandleFunctionLibrary";
const FILE = "src/SoupInfoRelay.ts";
const span = (line) => ({ file: FILE, line, col: 1, endLine: line, endCol: 1 });
const nodes = [];
let col = 0;
function add(id, ref, sem, line, extra = {}) {
  const r = ref ? refs.get(ref) : null;
  if (ref && !r) throw new Error("no reference node " + ref);
  const n = { id, refNode: ref ?? undefined, t3d: { class: r ? r.cls : extra.cls, props: r ? r.props : extra.props }, sem, pos: [col * 300, 0], origin: span(line) };
  col++;
  if (extra.defaults) n.pinDefaults = extra.defaults;
  if (extra.member) n.member = extra.member;
  nodes.push(n);
}
const varGet = (name) => ({ cls: "/Script/BlueprintGraph.K2Node_VariableGet", props: ['VariableReference=(MemberName="' + name + '",bSelfContext=True)'] });
const varSet = (name) => ({ cls: "/Script/BlueprintGraph.K2Node_VariableSet", props: ['VariableReference=(MemberName="' + name + '",bSelfContext=True)'] });
const fref = (lib, fn) => 'FunctionReference=(MemberParent="/Script/CoreUObject.Class\'' + lib + '\'",MemberName="' + fn + '")';
const T0 = "abfc_UpdateTarget_t0", I0 = "abfc_UpdateTarget_i0";
const call = (cls, fn) => ({ k: "call", class: cls, function: fn });

add("ev", "K2Node_CustomEvent_3", { k: "event", name: "UpdateTarget" }, 13);
add("g0", "K2Node_VariableGet_15", { k: "get", name: "OwnerPC" }, 14);
add("v0", "K2Node_CallFunction_34", call(KSL, "IsValid"), 14);
add("b0", "K2Node_IfThenElse_8", { k: "branch" }, 14);
add("p0", "K2Node_CallFunction_25", call("/Script/Engine.Controller", "K2_GetPawn"), 14);
add("c0", "K2Node_DynamicCast_2", { k: "cast", target: PLAYER }, 14);
add("g1", "K2Node_VariableGet_16", { k: "get", name: "BestInteractable_InteractA", class: PLAYER }, 15);
add("c1", "K2Node_DynamicCast_3", { k: "cast", target: POT }, 15);
add("g2", "K2Node_VariableGet_17", { k: "get", name: "CanFillSoupBowl", class: POT }, 16);
add("b1", "K2Node_IfThenElse_8", { k: "branch" }, 16);
add("g3", "K2Node_VariableGet_19", { k: "get", name: "ItemRow", class: POT }, 21);
add("n0", "K2Node_CallFunction_26", call(GIH, "Conv_GlobalItemToName"), 21);
add("s0", null, { k: "set", name: T0 }, 21, varSet(T0));
add("g4", "K2Node_VariableGet_20", { k: "get", name: "LastTarget" }, 22);
add("e0", "K2Node_CallFunction_27", call(KML, "EqualEqual_ObjectObject"), 22);
add("b2", "K2Node_IfThenElse_8", { k: "branch" }, 22);
add("g5", null, { k: "get", name: T0 }, 22, varGet(T0));
add("g6", "K2Node_VariableGet_21", { k: "get", name: "LastRowName" }, 22);
add("e1", "K2Node_CallFunction_28", call(KML, "EqualEqual_NameName"), 22);
add("b3", "K2Node_IfThenElse_8", { k: "branch" }, 22);
add("s1", "K2Node_VariableSet_7", { k: "set", name: "LastTarget" }, 23);
add("g7", null, { k: "get", name: T0 }, 24, varGet(T0));
add("s2", "K2Node_VariableSet_8", { k: "set", name: "LastRowName" }, 24);
add("r0", "K2Node_CallFunction_30", call(GIH, "GetGlobalItemRow"), 25);
add("bs0", "K2Node_BreakStruct_0", undefined, 27);
add("bs1", "K2Node_BreakStruct_1", undefined, 27);
add("z0", "K2Node_CallFunction_31", call(KML, "EqualEqual_DoubleDouble"), 28, { defaults: { B: "0.0" } });
add("z1", "K2Node_CallFunction_32", call(KML, "EqualEqual_DoubleDouble"), 28, { defaults: { B: "0.0" } });
add("al", "K2Node_CallArrayFunction_5", undefined, 28);
add("z2", "K2Node_CallFunction_33", call(KML, "EqualEqual_IntInt"), 28, { defaults: { B: "0" } });
add("bA", "K2Node_IfThenElse_8", { k: "branch" }, 28);
add("bB", "K2Node_IfThenElse_8", { k: "branch" }, 28);
add("bC", "K2Node_IfThenElse_8", { k: "branch" }, 28);
add("li", null, { k: "set", name: I0 }, 29, { ...varSet(I0), defaults: { [I0]: "0" } });
add("g8", null, { k: "get", name: I0 }, 29, varGet(I0));
add("g9", "K2Node_VariableGet_24", { k: "get", name: "Infos" }, 29);
add("al2", "K2Node_CallArrayFunction_5", undefined, 29);
add("lt", null, call(KML, "Less_IntInt"), 29, { cls: "/Script/BlueprintGraph.K2Node_CallFunction", props: [fref(KML, "Less_IntInt")], member: { class: KML, function: "Less_IntInt" } });
add("bl", "K2Node_IfThenElse_8", { k: "branch" }, 29);
add("g10", null, { k: "get", name: I0 }, 30, varGet(I0));
add("ag", null, undefined, 29, { cls: "/Script/BlueprintGraph.K2Node_GetArrayItem", props: ["bReturnByRefDesired=False"], member: { arrayItem: true } });
add("iv", "K2Node_CallFunction_34", call(KSL, "IsValid"), 30);
add("bv", "K2Node_IfThenElse_11", { k: "branch" }, 30);
add("ss", "K2Node_CallFunction_35", call(SOUP, "ShowSoup"), 30, { defaults: { bShowRemoves: "true" } });
add("g11", null, { k: "get", name: I0 }, 29, varGet(I0));
add("ad", null, call(KML, "Add_IntInt"), 29, { cls: "/Script/BlueprintGraph.K2Node_CommutativeAssociativeBinaryOperator", props: [fref(KML, "Add_IntInt")], member: { class: KML, function: "Add_IntInt" }, defaults: { B: "1" } });
add("inc", null, { k: "set", name: I0 }, 29, varSet(I0));
add("sv", "K2Node_VariableSet_9", { k: "set", name: "bLastVisible" }, 32, { defaults: { bLastVisible: "true" } });
add("f1", "K2Node_CallFunction_36", { k: "call", function: "HideAll" }, 17);
add("fz", "K2Node_VariableSet_10", { k: "set", name: "LastTarget" }, 18);
add("f2", "K2Node_CallFunction_37", { k: "call", function: "HideAll" }, 28);

const ASP = "AsAbiotic Player Character", ASD = "AsDeployed Pot Of Soup";
const wires = [
  ["ev.then", "b0.execute"], ["g0.OwnerPC", "v0.Object"], ["v0.ReturnValue", "b0.Condition"], ["g0.OwnerPC", "p0.self"],
  ["b0.then", "c0.execute"], ["p0.ReturnValue", "c0.Object"], ["c0.then", "c1.execute"],
  ["c0." + ASP, "g1.self"], ["g1.BestInteractable_InteractA", "c1.Object"],
  ["c1." + ASD, "g2.self"], ["c1.then", "b1.execute"], ["g2.CanFillSoupBowl", "b1.Condition"],
  ["c1." + ASD, "g3.self"], ["g3.ItemRow", "n0.InHandle"],
  ["b1.then", "s0.execute"], ["n0.ReturnValue", "s0." + T0],
  ["c1." + ASD, "e0.A"], ["g4.LastTarget", "e0.B"], ["s0.then", "b2.execute"], ["e0.ReturnValue", "b2.Condition"],
  ["g5." + T0, "e1.A"], ["g6.LastRowName", "e1.B"], ["b2.then", "b3.execute"], ["e1.ReturnValue", "b3.Condition"],
  ["b2.else", "s1.execute"], ["b3.else", "s1.execute"], ["c1." + ASD, "s1.LastTarget"],
  ["s1.then", "s2.execute"], ["g7." + T0, "s2.LastRowName"],
  ["s2.then", "r0.execute"], ["g3.ItemRow", "r0.RowHandle"],
  ["r0.Data", "bs0.AbioticInventoryItem"], ["bs0.ConsumableData", "bs1.AbioticConsumable"],
  ["bs1.HungerFill", "z0.A"], ["bs1.ThirstFill", "z1.A"], ["bs1.BuffsToAdd", "al.TargetArray"], ["al.ReturnValue", "z2.A"],
  ["r0.Valid", "bA.execute"], ["z0.ReturnValue", "bA.Condition"], ["bA.then", "bB.execute"], ["z1.ReturnValue", "bB.Condition"],
  ["bB.then", "bC.execute"], ["z2.ReturnValue", "bC.Condition"], ["bC.then", "f2.execute"], ["r0.NotValid", "f2.execute"],
  ["bA.else", "li.execute"], ["bB.else", "li.execute"], ["bC.else", "li.execute"],
  ["li.then", "bl.execute"], ["g8." + I0, "lt.A"], ["g9.Infos", "al2.TargetArray"], ["al2.ReturnValue", "lt.B"], ["lt.ReturnValue", "bl.Condition"],
  ["bl.then", "bv.execute"], ["g9.Infos", "ag.Array"], ["g10." + I0, "ag.Dimension 1"], ["ag.Output", "iv.Object"], ["iv.ReturnValue", "bv.Condition"],
  ["bv.then", "ss.execute"], ["ag.Output", "ss.self"], ["bs1.HungerFill", "ss.Hunger"], ["bs1.ThirstFill", "ss.Thirst"],
  ["bs1.BuffsToAdd", "ss.BuffsToAdd"], ["bs1.BuffsToRemove", "ss.BuffsToRemove"],
  ["ss.then", "inc.execute"], ["bv.else", "inc.execute"], ["g11." + I0, "ad.A"], ["ad.ReturnValue", "inc." + I0], ["inc.then", "bl.execute"],
  ["bl.else", "sv.execute"],
  ["b0.else", "f1.execute"], ["c0.CastFailed", "f1.execute"], ["c1.CastFailed", "f1.execute"], ["b1.else", "f1.execute"], ["f1.then", "fz.execute"],
];
const owned = JSON.parse(fs.readFileSync("spike/out/p3/unit.json", "utf8")).owned;
const mod = {
  irVersion: 1, profile: "ue5.4.4-1050002", mod: "goodsoupWagdD",
  assets: [{
    path: "/goodsoupWagdD/SoupInfo/BP_SoupInfoRelay",
    variables: [
      { name: T0, type: "name", flags: ["transient"], temp: true, origin: span(21) },
      { name: I0, type: "int", flags: ["transient"], temp: true, origin: span(29) },
    ],
    units: [{
      id: "event:UpdateTarget", kind: "event", name: "UpdateTarget", graph: "EventGraph",
      signature: { inputs: [], outputs: [] }, locals: [], nodes, wires, origin: span(13),
      adopt: { remove: owned },
    }],
  }],
};
fs.writeFileSync("spike/out/p3/UpdateTarget.ir.json", JSON.stringify(mod, null, 1));
console.log("nodes", nodes.length, "wires", wires.length, "remove", owned.length);
