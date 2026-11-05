# abfc roadmap

Sizes are rough estimates for one developer: S is under 1 week, M is 1 to 3 weeks, L is 3 to 6 weeks. Each phase ends with a tagged commit. Design references point to `docs/design.md`.

## Phase 0: spike (M)

Throwaway code in `spikes/`, run against a staged copy of the test mod only. Nothing is published, nothing touches the real mod, and backend changes stay on a local branch of the fork.

| Probe | Pass | Fail: what we do |
| --- | --- | --- |
| P1 Stubs reflection: `reflect` op for `Abiotic_PlayerCharacter_C` and `Deployed_PotOfSoup_C` plus the `/Script` classes they use | Generated `.d.ts` contain `BestInteractable_InteractA: Actor \| null`, `CanFillSoupBowl: boolean`, `ItemRow`, `Controller.K2_GetPawn`, and `GetGlobalItemRow` with exec outputs `Valid`/`NotValid` and pins `RowHandle`/`Data`. `Conv_GlobalItemToName` is pure. Every pin name is byte-identical to the 2026-11-05 export of `BP_PotInfoRelay`. | If member listing fails: try the property-chain walk with per-build offsets. If names are lossy: per-profile override file kept outside the repo. If pins cannot be materialized: stop and rethink stubs before Phase 1. |
| P2 Filter tagging | Blocked members carry `@deprecated Blocked by Blueprint filter: <rule>`. `K2_GetPawn`, `IsLocalController` and the PlayerController cast sit in `filterOverrides`. | Tag from `blueprint_filter_check` output only, as warnings. |
| P3 `UpdateTarget` slice: hand-written IR (no TS frontend yet) -> bp_apply adapter, with an adopt-style removal of the 41 hand-made nodes | Compiles clean. The existing relay bp_game_test (instant-tooltip Verify 2) passes unchanged. A new test (unowned relay, call `UpdateTarget`: `LastTarget` None, `bLastVisible` false, no Accessed None in the runtime log) passes. `RelayTick`'s call node still links. | If a node class fails, record it and use the probe P5 route. If the call link breaks, change the pass plan to recreate the shell first and re-check. If it still fails, Phase 1 changes scope to a new function in a new asset. |
| P4 Exec back-edge loop in a function and in the event graph | Compiles, and a game test counting to 10 reads 10. | StandardMacros `ForEachLoop`/`ForLoop` through a raw `K2Node_MacroInstance` (GUID from reflection). `break`/`continue` are deferred. |
| P5 Raw nodes through `k:"node"`: `K2Node_CallArrayFunction` (`Array_Length`), `K2Node_GetArrayItem`, `K2Node_BreakStruct` (`AbioticInventoryItem`) | Pins allocated with the right types, and compiles clean. | Add native kinds to bp_apply (`array_call`, `break_struct`, `make_struct`) on the fork. |
| P6 Map variable: extend bp_apply's type grammar locally (`map:name:int`), then add/find in a game test, then `mod_audit` | Compiles, the game test passes, the audit passes. | Maps and sets use the parallel-array lowering (Phase 4). The capability stays false. |
| P7 UserDefinedStruct: create one in staging (Python factory), use it as a variable and in a game test, then `mod_audit` | Creates, compiles, the test passes, the audit passes. | Mod-defined structs leave the plan. Only engine structs are supported, and the error ABFC2045 explains why. |
| P8 Build time: cold `reflect`, `apply` (one asset), `compile`, `game_test` | Numbers recorded in `spikes/timings.md`. Pass: one-asset cold build plus test under 2 minutes. | Over 2 minutes: the warm editor moves from Phase 2 into Phase 1. |
| P9 Pick and pin the exact TypeScript version, and confirm the frontend-isolation seam compiles | `typescript` exact version in the root `package.json`. | — |

Exit: a written result per probe in `spikes/RESULTS.md`, and `design.md` updated: (unverified) marks resolved, capabilities and fallbacks fixed.

## Phase 1: milestone 1, the the test mod relay slice (L)

Scope
- Monorepo skeleton: `@abfc/runtime`, `ir`, `env`, `compiler`, `backend`, `stubgen`, `testkit`, `cli`. Node 24 pinned, exact TS, `node:test`.
- `@abfc/env`: full precedence chain, Known Folder Documents lookup, Epic manifest discovery, Python discovery, headless-dir space check, the error shape from design 9.3, and `abfc doctor`.
- Backend: `backend_info` and `reflect` on the fork, plus `compileErrorNodeRefs` if it is small. The MCP stdio client and the bp_apply adapter with capability gating.
- `abfc stubs` for the two `/Game` classes, their `/Script` closure, and the mod's own assets (`_Manual` interfaces). Stub lock and version-mismatch errors.
- Compiler: the TS subset needed for `UpdateTarget` (casts, `?.`, `&&`, `===`, ExpandEnumAsExecs results, `for..of`, struct breaks, temps), passes 1 to 3 and 6, manifest, drift check, `abfc adopt`, source map.
- `abfc check`, `build`, `test` (testkit with `spawn`, `call`, `get`, `wait`, `expect`), `status`.
- Map and struct probes from Phase 0 stay as probes. Their results only set capability flags.

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

## Phase 3: widgets, hybrid mode (M)

Scope: `kind: "widget"` classes, `_Manual` stubs exposing designer widgets, owned graphs inside `WBP_PotInfo` and `WBP_PotInfoBuffLine` with the layout untouched, `create_widget`, and `liveHud` test marking with a manual checklist report.
Exit: WBP_PotInfo logic in TS, layout unchanged byte-for-byte outside owned graphs (checked by export diff), hidden tests pass, and the manual HUD check passes in PIE.

## Phase 4: maps, sets and structs (M, depends on P6 and P7)

Scope: native `Map`/`Set` if P6 passed (backend type grammar upstreamed), else parallel-array lowering with `Array_Find`. `@struct` classes as UserDefinedStruct if P7 passed.
Exit: a sample mod using a `Map<name,int>` and one struct builds, tests and passes `mod_audit`. Unsupported combinations fail with an ABFC error before launch.

## Phase 5: language service and lint polish (M)

Scope: `@abfc/ts-plugin` (subset diagnostics, hover showing the Blueprint node a line lowers to, quick fixes for `idiv` and `?.`), and `@abfc/eslint-plugin` rules: no heavy calls in tick (`GetAllWidgetsOfClass` and friends), replicated-variable writes without an authority check, RPC misuse, loops in tick, unbounded array growth. Watch mode for `abfc check`.
Exit: rules documented with examples, no false positives on the test mod, and the plugin gives the same diagnostics as `abfc check` on the full test corpus.

## Phase 6: upstream the backend (parallel track, starts after Phase 1, size depends on the maintainer)

Scope: rebase the fork's headless tools (bpkit, staging, headless runs) onto upstream 2.3.2 (which has its own `graphbuild.py` route), add `backend_info`, `reflect`, compile node refs and the optional extensions with unit tests, agree on version numbering, and open PRs to `theelites11gamer/abf-mod-editor-mcp`.
Exit: an upstream release containing protocol 1, and `abfc` pointing to it as the minimum backend.

## Phase 7: public release 1.0 (M)

Scope: docs (install, first mod, CLI reference, error code reference, backend setup, troubleshooting for OneDrive, spaces and non-English Windows), `abfc init` template, `abfc backend install` (pinned release, sha256 in the profile), npm publishing with provenance, semver, changelog, GitHub releases, and a check that no Deep Field-derived file is in any package (CI grep for stub headers or `/Game` reflection JSON).
Exit: a stranger on a clean Windows machine with only Node 24, Python and the Mod Editor goes from `npm create`/`abfc init` to a published-to-staging test mod by following the docs.

## Phase 8: `import_nodes` backend (S, only if Deep Field ships `ImportNodesFromText` to Python)

Scope: a server writer option using `renderT3D` text, capability `writers: ["import_nodes"]`, and a new profile if the build changes.
Exit: the full the test mod build passes with `"backend": {"kind": "import_nodes"}` and no compiler change (diff of `packages/compiler` is empty).
