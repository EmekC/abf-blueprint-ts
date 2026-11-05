# Spike P1 R1c: UField iteration filtered by outer. Runs inside bp_apply raw python.
import json
out = {"by_outer": {}, "types": {}}
WANT = ["/Script/Engine.Controller", "/Script/AbioticFactor.GlobalItemHandleFunctionLibrary",
        "/Script/Engine.KismetArrayLibrary", "/Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup.Deployed_PotOfSoup_C",
        "/Game/Blueprints/Characters/Abiotic_PlayerCharacter.Abiotic_PlayerCharacter_C"]
unreal.load_class(None, WANT[3]); unreal.load_class(None, WANT[4])
cnt = 0
for x in unreal.ObjectIterator(unreal.Field):
    cnt += 1
    try:
        o = x.get_outer()
        op = o.get_path_name() if o else ""
    except Exception:
        continue
    t = type(x).__name__
    out["types"][t] = out["types"].get(t, 0) + 1
    if op in WANT:
        out["by_outer"].setdefault(op, []).append([x.get_name(), t])
out["count"] = cnt
out["by_outer_counts"] = {k: len(v) for k, v in out["by_outer"].items()}
json.dump(out, open(core.CFG.tmpdir + "/probe_api.json", "w"), indent=1)
