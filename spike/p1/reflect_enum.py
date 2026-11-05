# Spike P1 R1: runs inside bp_apply raw python (globals: unreal, bp, asset_path, ctx, core).
# Enumerates functions / properties of a few classes without loading or exporting /Game assets as assets (load_class only).
import json

CLASSES = [
    "/Game/Blueprints/Characters/Abiotic_PlayerCharacter.Abiotic_PlayerCharacter_C",
    "/Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup.Deployed_PotOfSoup_C",
    "/Script/Engine.Controller",
    "/Script/Engine.Pawn",
    "/Script/Engine.Actor",
    "/Script/AbioticFactor.GlobalItemHandleFunctionLibrary",
    "/Script/Engine.KismetSystemLibrary",
    "/Script/Engine.KismetMathLibrary",
    "/Script/Engine.KismetArrayLibrary",
]

out = {"api": {}, "classes": {}}

def safe(fn, default=None):
    try:
        return fn()
    except Exception as e:  # noqa
        return {"_error": repr(e)[:200]}

out["api"]["has_ObjectIterator"] = hasattr(unreal, "ObjectIterator")
out["api"]["has_Function"] = hasattr(unreal, "Function")
out["api"]["has_Class"] = hasattr(unreal, "Class")
out["api"]["has_Property"] = hasattr(unreal, "Property")
out["api"]["has_Field"] = hasattr(unreal, "Field")

# functions per outer class: unreal.Function does not exist in this build; UFunctions show up as python type "Struct"
# when iterating unreal.Field, with get_outer() == the declaring class.
funcs_by_outer = {}
try:
    n_iter = 0
    for f in unreal.ObjectIterator(unreal.Field):
        n_iter += 1
        try:
            outer = f.get_outer()
            key = outer.get_path_name() if outer else ""
        except Exception:
            continue
        if key in CLASSES and type(f).__name__ == "Struct":
            funcs_by_outer.setdefault(key, []).append(f)
    out["api"]["function_iteration"] = "ok (ObjectIterator(unreal.Field), type name Struct, outer == class)"
    out["api"]["field_total"] = n_iter
except Exception as e:
    out["api"]["function_iteration"] = "error: " + repr(e)[:200]

for path in CLASSES:
    rec = {"path": path}
    cls = safe(lambda: unreal.load_class(None, path))
    if cls is None or isinstance(cls, dict):
        rec["load"] = "FAILED " + str(cls)
        out["classes"][path] = rec
        continue
    rec["load"] = "ok"
    rec["py_type"] = type(cls).__name__
    rec["class_path_name"] = safe(lambda: cls.get_path_name())
    # functions owned by this class
    key = rec["class_path_name"] if isinstance(rec["class_path_name"], str) else path
    fl = funcs_by_outer.get(key, [])
    rec["function_count"] = len(fl)
    rec["functions"] = sorted(f.get_name() for f in fl)
    # metadata / tooltip probe on first few
    meta = {}
    for f in fl[:5]:
        m = {}
        for attr in ("get_metadata", "get_meta_data", "get_editor_property", "get_tool_tip", "tooltip"):
            m[attr] = hasattr(f, attr)
        if hasattr(f, "get_metadata"):
            m["ToolTip"] = safe(lambda: f.get_metadata("ToolTip"))
        meta[f.get_name()] = m
    rec["metadata_probe"] = meta
    # super chain: get_super_class is not exposed; the CDO python type MRO lists the native wrapper ancestors only
    rec["super_chain"] = "get_super_class unavailable"
    # python-visible properties of the CDO
    cdo = safe(lambda: unreal.get_default_object(cls))
    if cdo is None or isinstance(cdo, dict):
        rec["cdo"] = "unavailable " + str(cdo)
        rec["py_properties"] = []
    else:
        names = []
        for n in dir(type(cdo)):
            if n.startswith("_"):
                continue
            try:
                cdo.get_editor_property(n)
                names.append(n)
            except Exception:
                pass
        rec["py_properties"] = sorted(names)
        rec["cdo"] = type(cdo).__name__
        rec["cdo_mro"] = [c.__name__ for c in type(cdo).__mro__]
    out["classes"][path] = rec

json.dump(out, open(core.CFG.tmpdir + "/reflect_enum.json", "w"), indent=1)
