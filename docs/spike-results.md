# Phase 0 spike results

- Date: 2026-11-05
- Editor build: `5.4.4-1050002` (Mod Editor 1.5.0), Windows
- Backend: `EmekC/abf-mod-editor-mcp` at commit `c1391923015823da8d2be33525ea9480d6e9d146` (main checkout untouched: same HEAD and clean status before and after). Spike backend change lives on local branch `abfc-spike-p0` in a separate git worktree (`<mcp>-abfc-spike`), saved as `spike/backend-p6-map.patch`, never committed.
- Node `v26.7.0` and npm `11.19.0` on the machine (the project pins Node 24, see P9).
- Target: a staged copy of Good Soup (`goodsoupWagdD`) only. The real mod, `/Game`, and the MCP repo were not modified. Nothing was published or uploaded. The staged copy was restored to the real mod's state at the end (`staging_status`: changed, added, removed, conflicts all empty).
- Raw evidence is in `spike/out/` (gitignored: it holds Deep Field-derived names, pins and reflection data, including every generated spec and IR file built from export text or pin lists: `raw-graph`, `raw-wired2`, `map-raw`, `UpdateTarget.ir.json`, `apply.spec.json`, `raw-eventgraph.spec.json`). Because it is not in the public repo, the key numbers and lines are quoted inline below. Scripts, the small hand-written specs and the step files are in `spike/` (`spike/p1` to `spike/p9`, `spike/mcp_call.py`); the `make_*.mjs` generators write their output to `spike/out/`. Relative `spec_file` paths in `spike/*/*.args.json` resolve against the repo root.
- `<headless root>` below means the backend's headless run directory; run folder names look like `20261105-184929-apply-07c0`.

## Summary

| Probe | Result | Key evidence | Follow-up |
| --- | --- | --- | --- |
| P1 Stubs reflection | PASS | 8/8 criteria true, 15/15 reference members byte-identical pin names, 1064 members materialized | Real `reflect` op is Phase 1/6 backend work. Cold reflect about 60-70 s (estimate) |
| P2 Filter tagging | PASS | 3 blocked refs found, 2 members tagged `@deprecated` without overrides, 0 with them | None |
| P3 `UpdateTarget` slice | PASS, but fail branch 1 triggered: attempt 1 failed on node classes (5 errors), the end criteria passed via the P5 raw-graph route | Compile clean, Verify 2 unchanged vs baseline (25/28, not 28/28; same 3 pre-existing failures), new test 6/6, `RelayTick` link intact | Native kinds plus `k:"node"` fail on wildcard pins (`cast` Object pin, `Array_Length`, `GetArrayItem`); recorded, P5 route used. "No Accessed None" is non-discriminating. Audit did not cover the stage |
| P4 Back-edge loop | PASS | Function and event graph both count to 10, 8/8 steps | None (macro fallback not needed) |
| P5 Raw nodes via `k:"node"` | FAIL for array nodes, PASS for `BreakStruct` | Wildcard pins stay undetermined, compile errors, rolled back | Fallback applied: native kinds `array_call`, `break_struct`, `make_struct`, widened by P3 and P6 to pin-type resolution for all wildcard-capable nodes |
| P6 Map variable | Compile PASS, game test PASS, audit NOT VERIFIED | `AddAndFind('Apple',7)` returned `(7, True)`, `Counts` read back `{Name("Apple"): 7}` | `containerTypes.map`: capability false until a stage audit passes; compile and game test passed. Needs a backend type-grammar patch and wildcard resolution. Audit must cover the stage |
| P7 UserDefinedStruct | Create/compile/test PASS, audit NOT VERIFIED | Struct created by Python factory, used as a variable, 4/4 steps | `@struct`: capability false until a stage audit passes; compile and game test passed. Fields cannot be authored from Python in this build. Audit must cover the stage |
| P8 Build time | PASS (conditional) | As built today: failed first apply 20.5 + raw apply 11.9 + compile 11.6 + test 14.6 = 58.6 s (cold reflect, 60-70 s, cached once per game version, excluded; with it 118.6-128.6 s, straddling 120 s). 38.1 s is the target once pin types are resolved up front | PASS depends on Phase 1 resolving pin types up front (native pin-resolving kinds do not exist yet) or on reflect being cached; otherwise the warm-editor fallback is needed |
| P9 TypeScript pin | PASS | `typescript` `6.0.3` exact, seam compiles (`tsc -b` exit 0) | Run on Node 24 (machine has Node 26, `EBADENGINE` warning) |

Cross-cutting follow-ups are listed at the end.

## P1 Stubs reflection: PASS

Pass rule (roadmap): "Generated `.d.ts` contain `BestInteractable_InteractA: Actor | null`, `CanFillSoupBowl: boolean`, `ItemRow`, `Controller.K2_GetPawn`, and `GetGlobalItemRow` with exec outputs `Valid`/`NotValid` and pins `RowHandle`/`Data`. `Conv_GlobalItemToName` is pure. Every pin name is byte-identical to the 2026-11-05 export of `BP_SoupInfoRelay`."

What was run (all headless, all on staged scratch assets `BP_ReflectHost` / `BP_ReflectPins`, no `reflect` op exists yet, so the backend's `bp_apply` was used to emulate it):
1. Member enumeration: `spike/p1/reflect_enum.py` as a `bp_apply` `raw` python block.
2. Property names: a `K2Node_GetClassDefaults` node with the `Class` pin set (`spike/p1/make_r1_spec.mjs`).
3. Pin materialization: one `k:"call"` / `k:"get"` node per member (`spike/p1/make_r2_spec.mjs`, 4 chunks), pins parsed from the resulting `final_0.t3d`.
4. Stub generation and comparison: `spike/p1/stubgen.mjs`, `spike/p1/compare_pins.mjs`.

Evidence (`spike/out/p1/`):
- `check.json`: all 8 criteria `true` (`BestInteractable_InteractA_Actor_null`, `CanFillSoupBowl_boolean`, `ItemRow`, `Controller_K2_GetPawn`, `GetGlobalItemRow_exec_Valid_NotValid`, `GetGlobalItemRow_pins_RowHandle_Data`, `Conv_GlobalItemToName_pure`, `pin_names_byte_identical`). `compared: 15, mismatches: 0`.
- `compare.json`: 15 reference members from the `BP_SoupInfoRelay` export compared with materialized templates, 15/15 ordered `PinName` lists byte-identical.
- 1064 members requested and materialized, all with pins, 0 missing (27 requested members were skipped by the spec generator, listed under `skipped` in `r2.map.json`).
- Stub lines: `BestInteractable_InteractA: Actor | null`, `CanFillSoupBowl: boolean`, `ItemRow: GlobalItemRowHandle`, `Controller.K2_GetPawn(): Pawn | null`, `GetGlobalItemRow(RowHandle): { exec: "Valid" | "NotValid"; Data: AbioticInventoryItem }` with `@bpExecOutputs Valid,NotValid`, `Conv_GlobalItemToName` tagged `@bpPure`.

Findings that change the design:
- `unreal.Function` and `unreal.Property` do not exist in this build. UFunctions are listed with `ObjectIterator(unreal.Field)` filtered by `get_outer() == cls` (45312 fields in total). Counts: `Abiotic_PlayerCharacter_C` 786 functions, `Deployed_PotOfSoup_C` 21, `Controller` 28, `Pawn` 33, `Actor` 151, `GlobalItemHandleFunctionLibrary` 40, `KismetSystemLibrary` 282, `KismetMathLibrary` 734, `KismetArrayLibrary` 32.
- `unreal.load_class` works for `/Game` classes (no `load_asset`, no export). `get_super_class` is unavailable, so the super chain cannot be walked from Python.
- Property names with real FNames come from the output pins of a `K2Node_GetClassDefaults` node whose `Class` pin default is set and whose class is preloaded through `bp_apply`'s `objects` map (route C in `spike/p1/make_r1_spec.mjs`). Output pins include inherited properties: 259 for `Abiotic_PlayerCharacter_C`, 10 for `Deployed_PotOfSoup_C`. Setting only the pin line gave unreliable results, and passing only `objects` gave no property pins. The Python-wrapper-name route and the property-chain walk were not needed.
- Metadata (tooltips, categories): the probe returned nothing useful through these Python routes. Stubs carry no tooltips in Phase 1.
- Pin types and names come from the nodes themselves, as the design assumed.

Timings: cold reflect for two `/Game` classes plus seven library classes took 5-6 `bp_apply` runs, roughly 60-70 s (estimate: the enumeration and property runs have no `seconds` field; the pin chunks measured 11.9-12.3 s each). Stub generation and comparison under 1 s.

Fallback: not needed. Scratch assets `BP_ReflectHost` and `BP_ReflectPins` were emptied after use and removed by the final resync.

## P2 Filter tagging: PASS

Pass rule (roadmap): "Blocked members carry `@deprecated Blocked by Blueprint filter: <rule>`. `K2_GetPawn`, `IsLocalController` and the PlayerController cast sit in `filterOverrides`."

What was run: `blueprint_filter_check` with `mod_root` `/goodsoupWagdD` (`spike/out/p2/filter_check.json`), the filter resolver ported to JS inside `spike/p1/stubgen.mjs`, and the override list `spike/p2/filterOverrides.json`.

Evidence:
- Filter content version `2026102301`, 664 rules, verdict "BLOCKED REFERENCES" with exactly 3 blocked references, all in `BP_SoupInfoRelay` and all under rule `/Script/Engine`: the cast to `/Script/Engine.PlayerController`, `Controller.IsLocalController`, `Controller.K2_GetPawn`. The other three assets have 0.
- Stubs generated without overrides (`spike/out/p1/stubs-nooverrides/`): 2 members tagged `@deprecated Blocked by Blueprint filter: Block /Script/Engine` (`K2_GetPawn`, `IsLocalController`, in the `Engine` stub).
- Stubs generated with overrides (`spike/out/p1/stubs/`): 0 `@deprecated`; both members carry `@bpFilterOverride Block /Script/Engine: mod_audit passed Good Soup`. The `Controller` class carries `@bpCastFilter Blocked by Blueprint filter: Block /Script/Engine` and the `PlayerController` cast entry is tagged as an override. Report in `_index.json`: 1064 members, deprecated 0, overridden 2.
- Override file shape (verified): `{"profile":"ue5.4.4-1050002","filterOverrides":[{"parent":"/Script/Engine.Controller","member":"K2_GetPawn","reason":"..."},{"parent":"/Script/Engine.Controller","member":"IsLocalController","reason":"..."},{"cast":"/Script/Engine.PlayerController","reason":"..."}]}`.
- Observation: of the 1064 materialized members only these two resolve to Block. The filter is path-prefix based (`Block /Script/Engine` with finer Allow lines).

Caveat: the claim "`mod_audit` passed these" rests on the existing Good Soup audit history (the reason string in the overrides). The audit run in this spike did not exercise the stage (see G1 below), though it did pass the real mod, which contains these three references.

## P3 `UpdateTarget` slice: PASS on compile and tests, only via the raw-graph route

Pass rule (roadmap): "Compiles clean. The existing relay bp_game_test (soup-instant-tooltip Verify 2) passes unchanged. A new test (unowned relay, call `UpdateTarget`: `LastTarget` None, `bLastVisible` false, no Accessed None in the runtime log) passes. `RelayTick`'s call node still links."

What was run: baseline on the untouched relay (compile, Verify 2, new test), unit extraction (`spike/p3/unit_nodes.mjs`), hand-written IR (`spike/p3/make_ir.mjs` -> `spike/out/p3/UpdateTarget.ir.json`, checked by `spike/p3/check_ir.mjs`), adapter (`spike/p3/ir2bpapply.mjs`), two applies, then link check and tests. Evidence is in `spike/out/p3/`.

Evidence:
- Unit: 41 owned nodes (matches the design), 0 shared, nothing links into the set by pin. The `RelayTick` call is `K2Node_CallFunction_9` with `FunctionReference=(MemberName="UpdateTarget",MemberGuid=7511668E...,bSelfContext=True)`.
- IR: 51 nodes, 75 wires, 2 transient temp variables (`abfc_UpdateTarget_t0` name, `abfc_UpdateTarget_i0` int). Every wire endpoint was checked against the reference and P1 pin data.
- Attempt 1 (adapter output as is: native `sem` kinds plus `k:"node"` for `BreakStruct` and the array nodes): FAIL, rolled back, 20.5 s, 5 compile errors: "type of Target Array is undetermined" (2x, `Array_Length`), "type of Array / Output is undetermined" (`GetArrayItem`), and "type of Object is undetermined" on both native `cast` nodes (the cast template has a wildcard `Object` input). Cause: `bp_apply` wires by text and never runs the engine's pin-type propagation.
- Attempt 2 (raw-graph route): take the whole EventGraph text from attempt 1's `final_0.t3d` (kept in the run folder after a rollback), patch the 6 wildcard pins to real types, apply as a `raw` graph together with the `variables` (without them: "property associated with Abfc Update Target T 0 could not be found"). Result: ok, compile errors `[]`, warnings `[]`, 11.9 s (178 nodes, 397 links).
- Compile report: 0 errors, 0 warnings, 11.6 s.
- Link check (`bp_read`): `K2Node_CallFunction_9` still exists, function `UpdateTarget`, no `error`, no `orphaned_pins`, `execute` linked as in the reference. The new event keeps a new `NodeGuid` while the call's `MemberGuid` still holds the old one; the call resolves by name and the compile has no warning. The shell-first fallback was not needed. Node count in the asset: 154 -> 164 (51 added, 41 removed).
- Verify 2 after the change: 25/28 passed, 38.8 s, per-step `ok` list identical to the baseline. The 3 failures (steps 15, 16, 17) are pre-existing in the baseline: step 15 fails with "Failed to find property 'primary_actor_tick'" (a wrong Python property name in the test itself) and 16-17 depend on it. So "passes unchanged" holds relative to the baseline, not as 28/28.
- New test: 6/6 ok, 14.6 s, `LastTarget` is "None", `bLastVisible` is False.
- "No Accessed None": `runtime_log` is `[]` in the baseline, after the change, and in the editor logs, including for the ORIGINAL graph (which calls `K2_GetPawn` on a None `OwnerPC`). The harness never surfaced a Blueprint script warning in this path, so this criterion cannot discriminate and passes vacuously. The unowned-relay test also gives identical observable results for old and new code; it shows the new code runs without crashing, not that it differs.

Findings that change the design:
- The original graph differs from the design 4.3 text in detail: no `OwnerPC` `IsValid`, the pot goes through a `StandardMacros` `IsValid`, and the zero checks are two `Double` compares plus `Array_Length` ANDed with `BooleanAND`. The spike IR followed the original's data flow.
- Native `cast` also needs its `Object` pin type fixed (not only array nodes).
- Audit criterion: not part of the P3 roadmap text, but note that the single audit run did not cover the staged relay (see G1).

Fallback: P3 fail branch 1 ("If a node class fails, record it and use the probe P5 route") was triggered. Attempt 1 failed on node classes (`cast` Object pin, `Array_Length`, `GetArrayItem`); they are recorded here and in P5, and the result was reached through the P5 raw-graph route. The end criteria (clean compile, Verify 2 unchanged vs baseline at 25/28, new test, `RelayTick` link) passed on that route. The shell-first fallback for the call link was not needed. The mechanism requirement from P5 applies (see P5).

## P4 Exec back-edge loop: PASS

Pass rule (roadmap): "Compiles, and a game test counting to 10 reads 10."

What was run: `spike/p4/make_loop_spec.mjs` -> `loop.spec.json` on `BP_LoopProbe` (counter loop: `I = 0; Count = 0; branch(I < 10) { Count += 1; I += 1; back-edge to branch } else return`), built both as function `CountFn` and as custom event `CountEv` in `EventGraph`; test steps in `spike/p4/loop.steps.json`.

Evidence (`spike/out/p4/`): apply ok (32 nodes, 52 links, compile errors `[]`, warnings `[]`), compile report clean, `bp_game_test` 8/8 passed: `CountFn` returned 10, `Count` equals 10, `CountE` equals 10 after `CountEv`. Exec back-edges are accepted by `bp_apply` `wires` with no special syntax.

Timings: apply 5.8 s, compile 5.3 s, game test 11.8 s. Fallback (`StandardMacros` loops): not needed, not tried.

## P5 Raw nodes through `k:"node"`: FAIL for array nodes, PASS for BreakStruct

Pass rule (roadmap): "Pins allocated with the right types, and compiles clean."

What was run: `spike/p5/raw.spec.json` (pin discovery), `raw-wired.spec.json` and `raw-wired2.spec.json` (wired attempts; `raw-wired2` is generated into `spike/out/p5/`), `make_raw_graph_spec.mjs` (workaround, writes `spike/out/p5/raw-graph.spec.json`), parsers in `spike/p5/pins.mjs`. Evidence in `spike/out/p5/`.

Per node class (all via `{"k":"node","class":...,"props":[...]}` with head lines copied from the reference export):

| Node class | Pin names | Pin types | Compile |
| --- | --- | --- | --- |
| `K2Node_BreakStruct` (`AbioticInventoryItem`) | right (44 pins) | right, from the struct | PASS |
| `K2Node_CallArrayFunction` (`Array_Length`) | right (`self`, `TargetArray`, `ReturnValue`) | `TargetArray` stays wildcard after wiring a typed array into it | FAIL: "type of Target Array is undetermined" |
| `K2Node_GetArrayItem` | right (`Array`, `Dimension 1`, `Output`) | `Array` and `Output` stay wildcard | FAIL: "type of Array / Output is undetermined" |

- Three errors in total on the wired attempt; `bp_apply` rolled back. Putting resolved pin lines in the node `props` does not help: templates come from a reconstructed scratch node and those lines are ignored (same 3 errors).
- Working workaround (proves the mechanism): a `raw` graph block with the array pins resolved to `int`. Apply ok, compile clean, game test passed: `Probe()` returned `(3, 2)` = `(Array_Length([1,2,3]), element at index 1)`.

Timings: apply 6.2-6.6 s, compile 6.1 s, game test 12.1 s.

Fallback applied (doc edit): native kinds `array_call`, `break_struct`, `make_struct` in `EmekC/abf-mod-editor-mcp`. P3 and P6 widen it: the backend must resolve pin types for every wildcard-capable node, not only array nodes: array functions, `GetArrayItem`, `cast` (`Object` input), `Map_*` functions, and probably `Select`, `MakeArray` and macros (these last three were not tested). Interim route that works without backend changes: two-phase apply (apply, read the rolled-back `final_0.t3d`, patch pins, apply the graph as `raw`). It costs one failed apply (10-20 s) per build, which is why Phase 1 should resolve types up front. See `design.md` 7.3 and 14.

## P6 Map variable: compile PASS, game test PASS, audit NOT VERIFIED

Pass rule (roadmap): "Compiles, the game test passes, the audit passes."

What was run: local backend patch to `parse_type` (`map:<K>:<V>`, `spike/backend-p6-map.patch`, 91 lines, in the `abfc-spike-p0` worktree; `python -m unittest tests.test_unit` there: 109 tests OK, run without `-I` which breaks the module path), then `spike/p6/map.spec.json`, `map-raw.spec.json` (generated by `make_raw_spec.mjs` into `spike/out/p6/`), and `map.steps.json`. Evidence in `spike/out/p6/`.

Evidence:
- `Counts` (`map:name:int`) imports as `VarType=(PinCategory="name",PinValueType=(TerminalCategory="int"),ContainerType=Map)`.
- Attempt 1 (`k:"call"` for `BlueprintMapLibrary.Map_Add` / `Map_Find`, all pins wired): FAIL, rolled back, 10.4 s, 6 errors "type of Target Map / Key / Value is undetermined". Same cause as P5.
- Attempt 2 (raw function graph with 6 pins patched: `TargetMap` -> name key with `PinValueType int`, `Key` -> name, `Value` -> int): ok, compile errors `[]`, 9.4 s. A raw rewrite of a function graph works, not only the event graph.
- Compile report clean, 8.9 s. Game test 6/6 passed, 21.5 s: `AddAndFind('Apple', 7)` returned `(7, True)`; `dict(get_editor_property('Counts'))` was `{Name("Apple"): 7}`.
- Set was not probed in Phase 0: the spike patch left `set:` refused. Native Set needs a `set:` grammar probe, else parallel-array lowering.
- Audit: NOT VERIFIED. The single `mod_audit` run mounted the real mod folder, not the stage, so none of the spike assets were audited (see G1).

Fallback: not applied. The roadmap fallback (parallel-array lowering, capability false) applies on failure only, and nothing failed. The capability `containerTypes.map` stays false until a stage audit passes; compile and game test passed. Turning it on also needs the local type-grammar patch landing in the backend and wildcard-pin resolution for `Map_*` nodes. If the audit fails, Phase 4 uses parallel-array lowering.

## P7 UserDefinedStruct: create/compile/test PASS, audit NOT VERIFIED

Pass rule (roadmap): "Creates, compiles, the test passes, the audit passes."

What was run: `spike/p7/create_struct.py` as a `raw` python block on `BP_StructHost` (`struct.spec.json`), a variable of that type on `BP_StructProbe`, `spike/p7/struct.steps.json`, and a field-authoring API probe `spike/p7/author_probe.py`. Evidence in `spike/out/p7/`.

Evidence:
- `unreal.StructureFactory` exists. `AssetToolsHelpers.get_asset_tools().create_asset("S_Probe", "/goodsoupWagdD/_abfcSpike", unreal.UserDefinedStruct, unreal.StructureFactory())` works, `EditorAssetLibrary.save_loaded_asset` returns True, and the asset lands in the stage. A new struct has one member `MemberVar_0_<guid>` of type bool. Apply 9.4 s.
- Variable type: `struct:/goodsoupWagdD/_abfcSpike/S_Probe` FAILS ("variable SP has an invalid type Structure", rolled back, 8.7 s). `struct:/goodsoupWagdD/_abfcSpike/S_Probe.S_Probe` (full object path) WORKS (8.6 s). Phase 1 must emit the full object path for mod structs.
- Compile report clean (8.8 s). Game test 4/4 passed (19.7 s): the variable reads as Python `StructBase`, `export_text()` is `(MemberVar_0_<guid>=False)`.
- Field authoring is NOT possible from this Python build: no `unreal.StructureEditorUtils`, and `editor_data` is not exposed on `UserDefinedStruct`. Choosing fields or renaming `MemberVar_0` needs a backend extension (a carrier import of the struct's editor data; the format is visible in the exported struct text).
- Audit: NOT VERIFIED (same reason as P6; `S_Probe.uasset` was never audited).

Fallback: not applied (the ABFC2045 fallback applies on failure only). The `@struct` capability stays false until a stage audit passes; compile and game test passed. Creation and use work, field authoring is a backend gap, and the audit and cloud cook acceptance of a mod-defined struct are unverified.

## P8 Build time: PASS

Pass rule (roadmap): "Numbers recorded in `docs/spike-results.md`. Pass: one-asset cold build plus test under 2 minutes."

Result, as built today: the only proven route needs the failed first apply, so one-asset cold build + test = 20.5 (failed native apply) + 11.9 (raw apply) + 11.6 (compile) + 14.6 (game test) = 58.6 s, on the P3 relay change. The 38.1 s figure (11.9 + 11.6 + 14.6) is the target once Phase 1 resolves pin types up front; it assumes native pin-resolving kinds that do not exist yet. Every headless call starts a fresh editor process, so every number below is a cold start. Details under "Timings".

- Cold reflect (about 60-70 s, estimate) is excluded from the pass figure: it is a once-per-game-version (cache) step, not part of the edit loop. Excluding it is defensible, but with it the as-built total is 118.6-128.6 s, which straddles the 120 s limit. With the 38.1 s target path (no failed apply) and reflect it would be 98.1-108.1 s.
- PASS depends on Phase 1 resolving pin types up front (removing the failed apply), or on reflect being cached. The warm-editor fallback (moves into Phase 1) is therefore avoided only conditionally, and is not triggered by this spike.

## P9 TypeScript pin and seam: PASS

Pass rule (roadmap): "`typescript` exact version in the root `package.json`." plus the seam compiles.

Evidence (`spike/out/p9/`):
- Root `package.json` pins `"typescript": "6.0.3"` (exact), `engines.node` is `">=24 <25"`, `.nvmrc` is `24`, `package-lock.json` is kept.
- npm dist-tags: `latest` is `7.0.2`, `next` is `7.1.0-dev`. The highest stable 6.x is `6.0.3`. The `exports` of TypeScript 7.0.2 have `.` -> `./lib/version.cjs` and only `./unstable/*` subpaths (`api`, `ast`, `sync`, `async`, `proto`): no stable programmatic compiler API, which design section 3 needs (compiler API and language-service plugin). So the pin stays on 6.x.
- Seam: `spike/p9` has project references `ir`, `compiler` (`hir`, `frontend`, `lower`), `runtime` stubs and a `sample` class. `npx tsc -b spike/p9` exits 0 with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useDefineForClassFields`, `nodenext`, `es2023`, `composite` and standard decorators. `grep -rl 'from "typescript"' spike/p9 --include=*.ts` lists only `spike/p9/compiler/src/frontend/index.ts`. No `@types/node` was needed. Build output was removed after the check.
- `npm install` on Node `v26.7.0` printed `npm warn EBADENGINE required node >=24 <25, current v26.7.0` (warning only, install succeeded).

Follow-up: run real work on Node 24; the machine has Node 26.

## Timings

All seconds are the tool's `seconds` (process wall) unless marked wall. Source: `spike/out/p8-timings.json` (gitignored; excerpts here).

| Step | Seconds | Note |
| --- | --- | --- |
| `bp_read` of the relay (export) | 13.3 wall (5.01 in the commandlet log) | `bp_read` has no `seconds` field |
| P3 baseline compile | 11.2 | |
| P3 baseline Verify 2 | 31.9 | 25/28, 3 pre-existing failures |
| P3 baseline new test | 13.7 | |
| P3 apply, attempt 1 (native, failed) | 20.5 | 5 wildcard errors, rolled back |
| P3 apply (raw graph) | 11.9 | the cold-build figure |
| P3 compile report | 11.6 | |
| P3 new game test | 14.6 | 6/6 |
| P3 Verify 2 after | 38.8 | 25/28, same as baseline |
| P4 apply / compile / test | 5.8 / 5.3 / 11.8 | |
| P5 apply (raw graph) / compile / test | 6.2 / 6.1 / 12.1 | failed wired attempts 6.3 and 6.6 |
| P6 apply (failed native) / apply (raw) / compile / test | 10.4 / 9.4 / 8.9 / 21.5 | |
| P7 create struct / apply (failed type) / apply / compile / test | 9.4 / 8.7 / 8.6 / 8.8 / 19.7 | |
| P1 pin chunks `r2-1..3` | 12.1, 12.3, 11.9 each | chunk 0 had no `seconds` (about 12 s) |
| Cold reflect total | about 60-70 (estimate) | 5-6 `bp_apply` runs |
| `mod_audit` | 44.5 | audited the real mod, 7 assets |

P8 summary: as built today 58.6 s (failed apply + raw apply + compile + test); with cold reflect 118.6-128.6 s; target with up-front pin resolution 38.1 s (98.1-108.1 s with reflect); threshold 120 s.

## Other findings

- UpdateTarget node count: 41 owned nodes, as in the design.
- Runtime "Accessed None" log format: not captured. The harness produced no such line for the original graph either, so design 8.5's log format stays unverified. `parse_runtime_log` keeps only `LogScript: Error|Warning` and "Blueprint Runtime Error" lines; the null-pointer path did not emit one.
- `bp_game_test` step key is `op` (not `step`): `spawn`, `python`, `get`, `assert`, `wait`. `python` steps can call `ctx['p'].call_method('Fn')` for Blueprint functions and custom events; several outputs come back as a tuple. `get` with `target:"$p"` reads Blueprint variables.
- `bp_apply` details: a failed apply rolls back the staged files but leaves `final_0.t3d` (with pins) in the run folder; `graphs[].remove` accepts real node names only and the reserved entry/event nodes of a fresh asset are not removable by name; in `functions[].nodes` the ids `entry` and `result` work, in a `graphs` edit use the real names (`K2Node_FunctionEntry_0`, `K2Node_FunctionResult_0`); a variable Get node's output pin and a Set node's value input pin are named after the variable; pin names with spaces work in `set` (`"gai.Dimension 1"`).
- `MemberGuid` on a `VariableReference`/`FunctionReference` to a replaced custom event stays stale after the replacement; resolution is by name for self-context calls.
- Metadata/tooltip availability: none via the Python routes tried (see P1).
- Problem found in the baseline test (not in abfc): Verify 2's `primary_actor_tick` Python name is wrong in this build, failing steps 15-17.
- Not probed: `multiPassPerAsset` (whether one `bp_apply` batch may list the same asset more than once). The spike used separate calls per pass.

## Remaining (unverified)

These marks in `design.md` were not settled by a probe and stay in place:
- `multiPassPerAsset` (7.3, and the matching risk-table row).
- Runtime log format for test errors (8.5): no sample captured.
- Non-ASCII user names in UE launch args (9.2, ABFC1012 note).
- The Python naming rule for `call` in testkit (section 11): `call_method` accepted Blueprint names as written in these tests, but the general snake-case derivation was not probed.
- Replacing an owned function whose signature changed (risk table).
- Audit and cloud-cook acceptance of map variables (P6), `Map_*` nodes, and mod-defined structs (P7). The audit did not cover the stage. The cloud cook was never run.

## Cross-cutting follow-ups

- `mod_audit` mounted the real mod folder (7 assets, mount point `.../Abiotic Factor Mods/goodsoupWagdD/Content/`), not the stage (15 assets at the time). Per-asset results for the spike assets and the P3-changed relay do not exist. The real mod was verified unchanged afterwards (relay checksum equal, no `_abfcSpike` folder). Fix needed: make `mod_audit` mount the stage, or audit a throwaway test mod (needs the user's approval; `bp_publish` was never called). `blueprint_filter_check` could not be rerun in the last batch (no live editor).
- `bp_read` and the first reflect runs lack a `seconds` field; add it.
- Backend work list for Phase 1/6: `reflect` op, `backend_info`, native pin-resolving kinds (array, struct, cast, map), map type grammar, UDS field authoring, `mod_audit` on the stage.
- The Verify 2 test bug (`primary_actor_tick`) belongs to the Good Soup test, not to abfc.
- Machine has Node 26; the project pins Node 24.
- The local backend worktree `<mcp>-abfc-spike` and branch `abfc-spike-p0` were left in place. Remove with `git -C <mcp> worktree remove <mcp>-abfc-spike` then `git -C <mcp> branch -D abfc-spike-p0`. The patch is saved as `spike/backend-p6-map.patch`.
