# Spike P7: runs inside bp_apply raw python (globals: unreal, bp, asset_path, ctx, core). Creates a UserDefinedStruct in the mod's _abfcSpike folder.
import json
out = {"steps": []}

def step(name, fn):
    try:
        r = fn()
        out["steps"].append({"step": name, "ok": True, "value": str(r)[:300]})
        return r
    except Exception as e:  # noqa
        out["steps"].append({"step": name, "ok": False, "error": repr(e)[:400]})
        return None

out["has_StructureFactory"] = hasattr(unreal, "StructureFactory")
out["has_UserDefinedStruct"] = hasattr(unreal, "UserDefinedStruct")
out["struct_api_names"] = sorted(n for n in dir(unreal) if "Struct" in n and ("Editor" in n or "UserDefined" in n or "Factory" in n))
s = None
if out["has_StructureFactory"]:
    s = step("create_asset", lambda: unreal.AssetToolsHelpers.get_asset_tools().create_asset(
        "S_Probe", "/goodsoupWagdD/_abfcSpike", unreal.UserDefinedStruct, unreal.StructureFactory()))
if s is not None:
    out["created_path"] = s.get_path_name()
    step("save", lambda: unreal.EditorAssetLibrary.save_loaded_asset(s, False))
    step("exists", lambda: unreal.EditorAssetLibrary.does_asset_exist("/goodsoupWagdD/_abfcSpike/S_Probe"))
    step("export_text", lambda: len(core.export_text(s, "s_probe.t3d")))
    step("dir_struct", lambda: [n for n in dir(s) if not n.startswith("_")][:60])
    if hasattr(unreal, "StructureEditorUtils"):
        out["StructureEditorUtils"] = [n for n in dir(unreal.StructureEditorUtils) if not n.startswith("_")]
json.dump(out, open(core.CFG.tmpdir + "/p7.json", "w"), indent=1)
