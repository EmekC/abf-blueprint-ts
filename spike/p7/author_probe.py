# Spike P7b: can fields of the (already created) S_Probe be added/renamed from Python? Not saved.
import json
out = {}
def t(name, fn):
    try:
        out[name] = str(fn())[:400]
    except Exception as e:  # noqa
        out[name] = "ERR " + repr(e)[:300]
s = unreal.load_asset("/goodsoupWagdD/_abfcSpike/S_Probe")
out["loaded"] = str(s)
names = [n for n in dir(unreal) if "StructureEditor" in n or "UserDefinedStructEditor" in n or "StructUtils" in n or "BPStructure" in n]
out["api_names"] = names
t("editor_data", lambda: s.get_editor_property("editor_data"))
t("struct_props", lambda: [n for n in dir(s) if "struct" in n.lower() or "var" in n.lower() or "field" in n.lower()])
t("set_vardesc", lambda: s.set_editor_property("editor_data", None))
t("add_variable", lambda: unreal.StructureEditorUtils.add_variable(s, unreal.EdGraphPinType()))
json.dump(out, open(core.CFG.tmpdir + "/p7b.json", "w"), indent=1)
