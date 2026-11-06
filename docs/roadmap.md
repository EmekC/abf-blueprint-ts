# abfc roadmap

Sizes are rough estimates for one developer: S is under 1 week, M is 1 to 3 weeks, L is 3 to 6 weeks. Each phase ends with a tagged commit. Design references point to `docs/design.md`.

## Phase 0: spike (M)

Throwaway code in `spike/`, run against a staged copy of the test mod only. Nothing is published, nothing touches the real mod, and backend changes stay on a local branch of `EmekC/abf-mod-editor-mcp`.

| Probe | Pass | Fail: what we do |
| --- | --- | --- |
| P1 Stubs reflection: `reflect` op for `Abiotic_PlayerCharacter_C` and `Deployed_PotOfSoup_C` plus the `/Script` classes they use | Generated `.d.ts` contain `BestInteractable_InteractA: Actor \| null`, `CanFillSoupBowl: boolean`, `ItemRow`, `Controller.K2_GetPawn`, and `GetGlobalItemRow` with exec outputs `Valid`/`NotValid` and pins `RowHandle`/`Data`. `Conv_GlobalItemToName` is pure. Every pin name is byte-identical to the 2026-11-05 export of `BP_PotInfoRelay`. | If member listing fails: try the property-chain walk with per-build offsets. If names are lossy: per-profile override file kept outside the repo. If pins cannot be materialized: stop and rethink stubs before Phase 1. |
| P2 Filter tagging | Blocked members carry `@deprecated Blocked by Blueprint filter: <rule>`. `K2_GetPawn`, `IsLocalController` and the PlayerController cast sit in `filterOverrides`. | Tag from `blueprint_filter_check` output only, as warnings. |
| P3 `UpdateTarget` slice: hand-written IR (no TS frontend yet) -> bp_apply adapter, with an adopt-style removal of the 41 hand-made nodes | Compiles clean. The existing relay bp_game_test (instant-tooltip Verify 2) passes unchanged. A new test (unowned relay, call `UpdateTarget`: `LastTarget` None, `bLastVisible` false, no Accessed None in the runtime log) passes. `RelayTick`'s call node still links. | If a node class fails, record it and use the probe P5 route. If the call link breaks, change the pass plan to recreate the shell first and re-check. If it still fails, Phase 1 changes scope to a new function in a new asset. |
| P4 Exec back-edge loop in a function and in the event graph | Compiles, and a game test counting to 10 reads 10. | StandardMacros `ForEachLoop`/`ForLoop` through a raw `K2Node_MacroInstance` (GUID from reflection). `break`/`continue` are deferred. |
| P5 Raw nodes through `k:"node"`: `K2Node_CallArrayFunction` (`Array_Length`), `K2Node_GetArrayItem`, `K2Node_BreakStruct` (`AbioticInventoryItem`) | Pins allocated with the right types, and compiles clean. | Add native kinds to bp_apply (`array_call`, `break_struct`, `make_struct`) in `EmekC/abf-mod-editor-mcp`. |
| P6 Map variable: extend bp_apply's type grammar locally (`map:name:int`), then add/find in a game test, then `mod_audit` | Compiles, the game test passes, the audit passes. | Maps and sets use the parallel-array lowering (Phase 4). The capability stays false. |
| P7 UserDefinedStruct: create one in staging (Python factory), use it as a variable and in a game test, then `mod_audit` | Creates, compiles, the test passes, the audit passes. | Mod-defined structs leave the plan. Only engine structs are supported, and the error ABFC2045 explains why. |
| P8 Build time: cold `reflect`, `apply` (one asset), `compile`, `game_test` | Numbers recorded in `docs/spike-results.md`. Pass: one-asset cold build plus test under 2 minutes. | Over 2 minutes: the warm editor moves from Phase 2 into Phase 1. |
| P9 Pick and pin the exact TypeScript version, and confirm the frontend-isolation seam compiles | `typescript` exact version in the root `package.json`. | — |

Exit: a written result per probe in `docs/spike-results.md`, and `design.md` updated: (unverified) marks resolved, capabilities and fallbacks fixed.

Result (2026-11-05): see `docs/spike-results.md`. P1, P2, P3, P4, P8 and P9 pass. P5 fails for wildcard array nodes (the native-kinds fallback applies, widened to every wildcard-capable node, see Phase 1). P6 and P7 pass compile and game test, but their audit criterion is NOT VERIFIED because the one `mod_audit` run covered the real mod, not the stage; their capabilities stay false until a stage audit passes (compile and game test passed), and the fallbacks apply only if a later audit of the stage fails. P3 triggered fail branch 1 (node classes recorded, P5 route used) and its end criteria passed on that route.

## Phase 1: milestone 1, the the test mod relay slice (L)

Scope
- Monorepo skeleton: `@abfc/runtime`, `ir`, `env`, `compiler`, `backend`, `stubgen`, `testkit`, `cli`. Node 24 pinned, exact TS, `node:test`.
- `@abfc/env`: full precedence chain, Known Folder Documents lookup, Epic manifest discovery, Python discovery, headless-dir space check, the error shape from design 9.3, and `abfc doctor`.
- Backend: `backend_info` and `reflect`, plus `compileErrorNodeRefs` if it is small, all in `EmekC/abf-mod-editor-mcp`. The MCP stdio client and the bp_apply adapter with capability gating.
- Backend, from Phase 0 probe P5 (failed, also seen in P3 and P6): native node kinds `array_call`, `break_struct`, `make_struct`, plus explicit pin-type resolution for every wildcard-capable node (array functions, `GetArrayItem`, `cast` with its `Object` pin, and later `Map_*`, `Select`, `MakeArray`, macros). `k:"node"` and native `cast` leave wildcard pins undetermined and the build fails. Until these land, the adapter may use the two-phase route proven in Phase 0 (apply, read the rolled-back `final_0.t3d`, patch the pins, apply the graph as `raw`), but it should resolve types up front because a failed first apply adds 10 to 20 s.
- `abfc stubs` for the two `/Game` classes, their `/Script` closure, and the mod's own assets (`_Manual` interfaces). Stub lock and version-mismatch errors.
- Compiler: the TS subset needed for `UpdateTarget` (casts, `?.`, `&&`, `===`, ExpandEnumAsExecs results, `for..of`, struct breaks, temps), passes 1 to 3 and 6, manifest, drift check, `abfc adopt`, source map.
- `abfc check`, `build`, `test` (testkit with `spawn`, `call`, `get`, `wait`, `expect`), `status`.
- Map and struct probes from Phase 0 stay as probes. Their results only set capability flags (both false until a stage audit passes; compile and game test passed, see Phase 4).

Exit criteria
- The the test mod TS project (outside the mod folder) holds `UpdateTarget` in TS. `abfc build` adopts and replaces the hand-made event, compiles clean, and passes the existing relay game test plus the new `UpdateTarget` tests, all from a plain terminal with no MCP client.
- Editing a generated node in the editor makes the next build fail with ABFC5001, and nothing is overwritten.
- A deliberate type error and a deliberate Unreal compile error both show up at the correct `file.ts:line:col` in VS Code's Problems panel.
- `abfc doctor` passes on a second Windows account whose user name contains a space and whose Documents folder is redirected. The doctor prints the headless-dir advice and the build works after following it.
- A changed editor fingerprint (simulated) triggers ABFC3001.
- Build timings recorded. Nothing published to the real mod unless the user runs `abfc publish` (the gate is a stub in Phase 1: build plus test plus `mod_audit` plus dry-run only).

## Phase 2: full the test mod port (L)

Scope: the relay's other events (`TryInitLocal`, `RelayTick`, `EnsureInjected`, `HideAll`, `CleanupUI`, overrides `ReceiveTick`/`ReceiveEndPlay`), the class defaults pass (tick interval, replication, net frequencies), `BPC_PotInfoDirector` with `classManagerRow`, the full release gate, warm editor (`warmSession` backend extension), and unit-level incremental builds.
Exit: the test mod's relay and director logic is entirely in TS. Every hand-made graph in those two assets has been adopted or deleted. The PIE host and client check from the the test mod plans gives the same table. `abfc publish` passes the full gate. A warm incremental build of one changed unit runs in under 30 s (target, measured).

Result (2026-11-06): see `docs/phase2-results.md`. The relay and the director are entirely in TS, every hand-made unit and comment box of both EventGraphs was adopted or deleted, and class defaults come from `@blueprint` options (EC1, EC2 met; `classManagerRow` is verified, not written). `abfc publish --dry-run` exits 0 and `abfc publish` exits 3 (`ABFC7001`) after all seven gates, with a stage `mod_audit` that passes live (EC4 met; `bp_publish` never called). A warm incremental build of one changed unit takes a median of 14.4 s (EC5 met). An Unreal compile error shows at `file.ts:line:col` (the Phase 1 EC3 gap is closed). EC3 (the PIE host and client table) is Partial: the hidden-game equivalent matches (Verify3Hidden 17/20, the 3 misses are the tick-group known issue), but the real 2-client PIE check needs the desktop editor and is left to the user with the written procedure. Backend work stays on the uncommitted branch `abfc-p2-backend`: `warmSession`, compile node refs from the node `ErrorMsg`, the stage `mod_audit` picker fix, spawn and create-widget return typing. Moved on: a restore after a post-apply compile failure (backend restore tool) and an opt-in drift read for unchanged builds go to Phase 5; writing `classManagerRow` rows goes to Phase 6; the `liveHud` test marker stays in Phase 3.

## Phase 3: widgets, hybrid mode (M)

Scope: `kind: "widget"` classes, `_Manual` stubs exposing designer widgets, owned graphs inside `WBP_PotInfo` and `WBP_PotInfoBuffLine` with the layout untouched, `create_widget`, and `liveHud` test marking with a manual checklist report.
Exit: WBP_PotInfo logic in TS, layout unchanged byte-for-byte outside owned graphs (checked by export diff), hidden tests pass, and the manual HUD check passes in PIE.

## Phase 4: maps, sets and structs (M, depends on P6 and P7)

Scope: native `Map` (not `Set`) if the P6 audit criterion passes (backend type grammar extended in `EmekC/abf-mod-editor-mcp` from `spike/backend-p6-map.patch`, plus wildcard-pin resolution for `Map_*` nodes); P6 compile and game test passed in Phase 0, the audit was not verified. If a later audit of the stage fails, parallel-array lowering with `Array_Find` and the capability stays false. Set not probed in Phase 0; native Set needs a `set:` grammar probe, else parallel-array lowering. `@struct` classes as UserDefinedStruct if the P7 audit criterion passes (compile and game test passed in Phase 0, the audit was not verified); this also needs a backend extension for field authoring, since Python in this build can create the struct but not set its fields, and mod struct variable types use the full object path (`.../S_Probe.S_Probe`). If the audit fails, `@struct` is dropped and ABFC2045 explains why.
Exit: a sample mod using a `Map<name,int>` and one struct builds, tests and passes `mod_audit`. Unsupported combinations fail with an ABFC error before launch.

## Phase 5: language service and lint polish (M)

Scope: `@abfc/ts-plugin` (subset diagnostics, hover showing the Blueprint node a line lowers to, quick fixes for `idiv` and `?.`), and `@abfc/eslint-plugin` rules: no heavy calls in tick (`GetAllWidgetsOfClass` and friends), replicated-variable writes without an authority check, RPC misuse, loops in tick, unbounded array growth. Watch mode for `abfc check`. Stub hover text: every callable function in the generated `.d.ts` stubs (game, engine and mod classes) carries a short, precise one-line description followed in parentheses by the node's display name in the Blueprint node editor, e.g. `K2_GetPawn` gives "Returns the pawn this controller possesses (Get Controlled Pawn).", shown by VS Code on hover and in completion. Phase 0 found that the cooked Mod Editor strips function metadata (tooltips, display names) through the Python routes tried, so the text comes from (a) a backend probe for a metadata route that works, for example reading the title and tooltip of a spawned K2 node, which `reflect` already creates for pin materialization (see Phase 6), or otherwise (b) the display name derived by Unreal's own naming rule (strip `K2_`, split camelCase) plus a curated description file kept in the repo for the common classes, with no Deep Field-derived text copied verbatim. Your own doc comments: a TS `/** ... */` comment on an `@event` or function member becomes the tooltip of that Blueprint function or event in the editor, plus category and keywords if feasible, through the Phase 6 `bp_apply` metadata extension.
Exit: rules documented with examples, no false positives on the test mod, and the plugin gives the same diagnostics as `abfc check` on the full test corpus. Every stubbed function in the the test mod corpus has a one-line description with its node-editor name in parentheses, and a TS doc comment shows as the tooltip of its Blueprint function or event in the editor.

## Phase 6: backend extensions in EmekC/abf-mod-editor-mcp (parallel track, starts after Phase 1, M)

Scope: add `backend_info` (protocol 1), `reflect`, compile node refs and the optional extensions from design section 14 (map/set types, UserDefinedStruct, function locals, `warmSession`) to `EmekC/abf-mod-editor-mcp`, with unit tests, a changelog and tagged releases. Version numbers are owned by that repo. Also two probes, each becoming an extension if it works or a documented fallback if not: a metadata route for `reflect` (node title and tooltip read from a spawned K2 node, feeding the stub descriptions from Phase 5), and function and event metadata in `bp_apply` (tooltip, category, keywords), so TS doc comments reach the editor.
Exit: a tagged release of `EmekC/abf-mod-editor-mcp` that reports protocol 1 and the required capabilities, and `abfc` pointing to it as the minimum backend.

## Phase 7: public release 1.0 (M)

Scope: docs (install, first mod, CLI reference, error code reference, backend setup, troubleshooting for OneDrive, spaces and non-English Windows), `abfc init` template, `abfc backend install` (pinned release, sha256 in the profile), npm publishing with provenance, semver, changelog, GitHub releases, and a check that no Deep Field-derived file is in any package (CI grep for stub headers or `/Game` reflection JSON).
Exit: a stranger on a clean Windows machine with only Node 24, Python and the Mod Editor goes from `npm create`/`abfc init` to a published-to-staging test mod by following the docs.

## Phase 8: `import_nodes` backend (S, only if Deep Field ships `ImportNodesFromText` to Python)

Scope: a server writer option using `renderT3D` text, capability `writers: ["import_nodes"]`, and a new profile if the build changes.
Exit: the full the test mod build passes with `"backend": {"kind": "import_nodes"}` and no compiler change (diff of `packages/compiler` is empty).
