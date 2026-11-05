// Generates spike/out/p1/r1.spec.json (route A: GetClassDefaults nodes with the Class pin default set via a pin line).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const route = process.argv[2] ?? "A"; // A: pin line; B: objects only; C: pin line + objects (objects makes bp_apply preload the /Game class)
const pyFile = process.argv[3] ?? "reflect_enum.py";
const CLASSES = [
  "/Game/Blueprints/Characters/Abiotic_PlayerCharacter.Abiotic_PlayerCharacter_C",
  "/Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup.Deployed_PotOfSoup_C",
];
const hex = () => Array.from({ length: 32 }, () => "0123456789ABCDEF"[Math.floor(Math.random() * 16)]).join("");
// same attribute order as t3d._pin_text, plus DefaultObject before PersistentGuid
function classPin(path) {
  return 'CustomProperties Pin (PinId=' + hex() + ',PinName="Class",PinType.PinCategory="class",PinType.PinSubCategory="",' +
    'PinType.PinSubCategoryObject="/Script/CoreUObject.Class\'/Script/CoreUObject.Object\'",PinType.PinSubCategoryMemberReference=(),' +
    'PinType.PinValueType=(),PinType.ContainerType=None,PinType.bIsReference=False,PinType.bIsConst=False,PinType.bIsWeakPointer=False,' +
    'PinType.bIsUObjectWrapper=False,PinType.bSerializeAsSinglePrecisionFloat=False,DefaultObject="' +
    "/Script/Engine.BlueprintGeneratedClass'" + path + "'" +
    '",PersistentGuid=00000000000000000000000000000000,bHidden=False,bNotConnectable=False,bDefaultValueIsReadOnly=False,' +
    'bDefaultValueIsIgnored=False,bAdvancedView=False,bOrphanedPin=False,)';
}
const add = CLASSES.map((c, i) => {
  const n = { id: "gcd" + route + i, k: "node", class: "/Script/BlueprintGraph.K2Node_GetClassDefaults", props: route !== "B" ? [classPin(c)] : [] };
  if (route !== "A") n.objects = { Class: c };
  return n;
});
const spec = [{
  asset: "/goodsoupWagdD/_abfcSpike/BP_ReflectHost",
  create: { class: "Blueprint", parent: "/Script/Engine.Actor", if_missing: true },
  graphs: [{ graph: "EventGraph", add }],
  raw: [{ kind: "python", code: readFileSync(join(here, pyFile), "utf8") }],
}];
const out = join(here, "..", "out", "p1", "r1" + route.toLowerCase() + ".spec.json");
writeFileSync(out, JSON.stringify(spec, null, 1));
console.log(out);
