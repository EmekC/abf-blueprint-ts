# Phase 1 results

Status: Phase 1 run complete on Good Soup. The offline parts (compiler, backend adapter, CLI, fake-backend end-to-end tests) are implemented and the live runs (fallback route, native route on a temporary integration backend) are recorded below. EC1, EC2 and EC5 are met; EC3, EC4 and EC6 are partial; see the final verdicts and the open items.

No path on any machine appears in this document: paths are written as settings (`ABFC_BACKEND_DIR`, `<project>`, `<mod folder>`).

## Exit criteria

| Criterion | Offline evidence | Live result |
| --- | --- | --- |
| EC1 `UpdateTarget` in TypeScript; `abfc build` adopts and replaces the hand-made event, compiles clean, passes the existing relay test (relative to its baseline) plus the new tests, from a plain terminal | `packages/cli/test/e2e.test.ts` (a), (g): adopt, build on the fallback route, rebuild is up to date, resync replays the adoption | **Met** (p1 backend alone, fallback route). `abfc adopt` listed 41 owned nodes, entry `K2Node_CustomEvent_3`, exit 3 (ABFC5006) until `--yes`; `abfc build` printed `applied UpdateTarget ... (route: fallback)`, compile clean (77.0 s cold; an earlier cold build 64.3 s). `bp_read` afterwards: the `RelayTick` call to `UpdateTarget` exists with `execute` linked, no `error`, no `orphaned_pins`, the hand-made `K2Node_CustomEvent_3` is gone. Baseline (untouched stage): UpdateTarget tests 6/6 and 7/7, Verify 2 25/28 with 3 ABFC6102 warnings; after the build: the same, and the per-step ok list of Verify 2 equals the Phase 0 baseline (`1111111111111110001111111111`). A second `build` is "up to date", `abfc status` shows `event:UpdateTarget clean`. **Native route also met** (temporary integration backend = the p1 backend plus the wildcard-pins fix, see Backend work): `doctor` printed `wildcard pin types: native` and `cast Object: typed by backend`; `build --resync` printed `applied UpdateTarget ... (route: native)` with one main apply and no phase A/B, compile clean, 54.5 s total; the event hash is identical to the fallback build (`e83cdb93 b4f8b1d6`), the link check gives the same result, and the three tests give the same results (6/6, 7/7, Verify 2 25/28 with the same 3 ABFC6102 warnings). |
| EC2 editing a generated node makes the next build fail with ABFC5001; nothing is overwritten | e2e (b): no `bp_apply` call after the edit, `abfc status` shows `edited` | **Met.** A simulated editor edit on the stage (`B` pin of the owned `EqualEqual_DoubleDouble` node set from `0.0` to `5.0` with `bp_apply`): `build` exits 3 with `src/SoupInfoRelay.ts:13:3: error ABFC5001: BP_SoupInfoRelay event UpdateTarget was edited in the editor since the last build (1 node changed, 0 links added, 0 links removed). abfc will not overwrite it.`; the timings of that run list only frontend, backendStart, stage and read (no `apply.*` step); `bp_read` after the refused build still shows `B` = `5.0`; `status` shows `edited` (exit 3). After setting `B` back to `0.0`, `status` is `clean` and `build` is "up to date". |
| EC3 a type error and an Unreal compile error print at `file.ts:line:col` in the problem-matcher format | e2e (c): the Unreal error is printed at the span of the name comparison; every diagnostic line in every e2e run is checked against the matcher regex | **Partial.** Type error: `const bad: boolean = "x";` in `UpdateTarget` gives `src/SoupInfoRelay.ts:14:11: error ABFC2000: [TS2322] Type 'string' is not assignable to type 'boolean'.`; every diagnostic line with a file position in these runs matches the problem-matcher regex, `check` is clean again after removing the line. Unreal error: with the profile function for name equality replaced by `EqualEqual_IntInt`, `check` is clean and `build` exits 1 after phase A with four `src/SoupInfoRelay.ts:13:3: error ABFC6002: [Unreal] Can't connect pins ... Integer is not compatible with Name. (node not identified)` lines; the stage is rolled back (the next `build` after reverting the profile is "up to date"). The position is the event span (13:3), not the `rowName === this.LastRowName` comparison: the p1 backend's compile log lines end in `from Source: <asset path>` with no `:<graph>.<node>` part, so `compile_node_refs` has no node to report. The Problems-panel check in VS Code is left to the user. |
| EC4 `abfc doctor` on a second account (user name with a space, redirected Documents folder) prints the headless-dir advice; build works after following it | `packages/cli/test/doctor.test.ts` with a fake machine | (live; the real second account needs the user): simulated account (`LOCALAPPDATA` under a folder with a space, `ABF_HEADLESS_DIR` unset): `doctor` prints ABFC1012 with the advice, exit 2; with `ABF_HEADLESS_DIR` set: exit 0, warning ABFC4012, `wildcard pin types: fallback`, extensions `reflect, compile_node_refs, bp_read_seconds`. The real second account still needs the user. |
| EC5 a changed editor fingerprint triggers ABFC3001 | e2e (d): `build` exits 2, `check` warns and exits 0 | **Met.** With `editorFingerprint` in `stubs.lock.json` set to `sha256:simulated`: `build` exits 2 with `abfc: error ABFC3001: stubs were generated for Mod Editor ue5.4.4-1050002 (1.5.0) but the installed editor is 1.5.0.31876 (1.5.0). Run "abfc stubs" to regenerate.` (1 s, no backend call); `check` prints the same text as a warning and exits 0. The value was restored afterwards. |
| EC6 timings recorded; nothing published; `abfc publish` is a stub | e2e (f): `--dry-run` exits 0, no `bp_publish` call; without `--dry-run` ABFC7001, exit 3. Timings in `.abfc/runs.jsonl` (e2e (a)) | **Partial.** Timings: recorded by `--timings` and `.abfc/runs.jsonl` for every step (tables below). Nothing published: no `bp_publish` call appears in any abfc output, the client allowlist refuses it (ABFC4090), and the sha256 of every file of the real mod folder is identical before and after the live run; the stage was restored (`staging_sync` with `discard_changes`, `staging_status` all lists empty). Publish stub, live: `abfc publish --dry-run` ran check, build (replaying the adoption), the three tests (all pass) and printed the ABFC7003 warning, then stopped with `abfc: error ABFC7002: mod_audit reported problems for <mod>.` and exit 1 instead of printing `would publish:` and exiting 0; plain `abfc publish` stopped the same way (exit 1) before it reached ABFC7001 (exit 3). Cause: the backend's `mod_audit` (hidden-desktop mod picker) did not complete; its editor log shows the picker mounting a different mod from the mods folder in each of the two runs, so the "Asset audit complete" line never appeared. The Phase 0 audit run on the same machine completed in 44.5 s, so this looks like a flaky picker in the backend, not an abfc fault; abfc's behaviour (an audit that does not complete is an error) is as designed. The would-publish list at that point, from `staging_status`, is one changed file: the relay asset. ABFC7001 with exit 3 and the dry-run with exit 0 are verified offline only (e2e (f)). |

## Timings

Recorded by `abfc build --timings` and `.abfc/runs.jsonl` (steps `build.frontend`, `build.backendStart`, `build.stage`, `build.read`, `apply.main` or `apply.phaseA` + `apply.phaseB`, `apply.tags`, `build.compile`, `build.total`, `test.<name>`).

| Step | Fallback route (seconds) | Native route (seconds) |
| --- | --- | --- |
| build.frontend | 0.3 | 0.3 |
| build.backendStart | 0.2 | 0.2 |
| build.stage | 0.0 | 0.0 |
| build.read | 14.3 (12.2 on the earlier cold build) | 12.5 |
| apply.main | not used | 14.4 |
| apply.phaseA | 16.6 (13.4) | not used |
| apply.phaseB | 15.0 (12.7) | not used |
| apply.tags | 15.8 (13.7) | 13.4 |
| build.compile | 14.8 (11.8) | 13.7 |
| build.total | 77.0 (64.3) | 54.5 |
| test.<name> | UpdateTarget tests 14.0-16.6 each; Verify 2 34.4-35.5 | UpdateTarget tests 14.4 and 21.4 (the first test of a cold run); Verify 2 33.3 |
| mod_audit | did not complete (see EC6); the Phase 0 run took 44.5 s | not run |

Fallback route on the p1 backend alone, cold hidden editor per call (every backend call starts the editor). `abfc stubs`: read of the two mod assets 26.4 s, reflection 36.0 s (7 reflect units), emit 0.06 s (54 files). Phase 0 P8 measured 58.6 s for failed apply + raw apply + compile + test (without read and tags); the same steps here are 16.6 + 15.0 + 14.8 + 14.0 = 60.4 s, and the whole `build` is 77.0 s because abfc also reads the asset (14.3 s) and writes the ownership tags (15.8 s). A refused build (ABFC5001) costs one read (13.9 s); a fingerprint refusal costs about 1 s. Native route (temporary integration backend): the whole `build` is 54.5 s, 22.5 s less than the fallback route, because the failed first apply plus the raw second apply (31.6 s together) become one apply (14.4 s). The 38 s design target is not reached because every backend call still starts a cold hidden editor (read 12.5 s, tags 13.4 s, compile 13.7 s). `publish --dry-run` took 141 s up to the audit (check, build 69.9 s, three tests 70.6 s).

## Design deltas

Where the implementation differs from [design.md](design.md):

- Language and tooling: packages compile with `tsc -b` to `dist/` (ESM, `nodenext`), tests are `node:test` files compiled from TypeScript. There is no linter in Phase 1 (`@abfc/eslint-plugin` is Phase 5); `npm run build` is the gate.
- Shared data shapes (`Profile`, `BackendCapabilities`, `BackendInfo`, `ApplyPlan`, `TestCase`, `Span`, `Diagnostic`) live in `@abfc/ir`, so `@abfc/compiler` depends only on `ir` and `typescript`. `@abfc/stubgen` is pure; the CLI makes the backend calls.
- Stub module specifiers are UE package paths resolved with `tsconfig` `paths`. The mapping uses the `*.js` form (`/Script/*` -> `.../Script/*.js`). `abfc stubs` writes `.abfc/tsconfig.paths.json` (machine specific, not committed); the project `tsconfig.json` extends it.
- Stub scope: `stubs.classes` and the new key `stubs.scriptClasses` get full members; structs referenced by pins get fields (depth 2); other referenced classes and enums are opaque. `stubs.scriptModules` is accepted and ignored with warning ABFC3010. Members inherited through Blueprint-to-Blueprint parent chains are missing.
- Tests are compiled statically from `*.test.ts` into `bp_game_test` steps with spans; they are not executed in Node. `.knownIssue(reason)` marks a pre-existing failure (warning ABFC6102 while it fails, ABFC6103 when it passes).
- TS subset: only what `UpdateTarget` needs. Everything else is ABFC2099 "not supported in Phase 1".
- IR: node ids are per-unit emission-order ids (`cast1`, `call8`), not AST paths. `IrNode.pinTypes` (wildcard resolution) and `IrModule.classMeta` (meta class for pin object text) are additions to design 6.1.
- Apply: one `bp_apply` call per asset for variables, shells and graph edits; the ownership comment boxes go in a separate `tags` call whose failure is warning ABFC5101. Spec node ids are `<unit name>_<IR id>`.
- Wildcard pins: one apply with `pin_types` when the backend's `backend_info` reports `pin_types`; otherwise the two-phase route (apply, read the rolled-back `final_<i>.t3d`, patch the wildcard pins, apply the whole graph as a raw block).
- A backend without `backend_info` is not an error: warning ABFC4012 and the fallback route (design 7.2 asked for an error). ABFC4001 stays for missing core tools and for `protocol` below `backend.minProtocol`.
- Capabilities that `backend_info` does not report come from a static bp_apply protocol-1 base, from `tools/list` and from the opt-in `abfc_extensions` tool. abfc's container policy stays `array` only whatever the backend reports.
- Hashes (`assetHash`, adoption hash) are computed by abfc's own T3D parser from the export text in the backend run folder, so both sides of every comparison use one algorithm. abfc reads run folders and never copies files out of them into the project.
- The source map folder is `.abfc/sourcemaps/` (design 8.5 says `.abfc/sourcemap/`).
- The manifest is per stage: each unit records the stage `syncedAt` it was applied on; after a resync the build replays the adoption and verifies the hand-made nodes' hash (ABFC5004 if they changed).
- `abfc adopt` refuses a unit abfc has already applied (ABFC5007, exit 3), because it would discard editor edits. `--discard-editor-changes` (with `--yes`) overrides it: the old generated nodes and their ownership comment are added to the adoption record, so the next build removes them with the adopted nodes. ABFC5001 names this command.
- `abfc publish` is a stub: check, build, test, `mod_audit`, then the list of staged files; `--dry-run` exits 0, otherwise ABFC7001 (exit 3). It never calls `bp_publish`.
- The MCP client has a tool allowlist; any other tool, `bp_publish` in particular, is ABFC4090 (exit 3).
- `abfc doctor --deep` and environment caching (`.abfc/cache/env.json`) are not in Phase 1.

## Backend work

abfc uses `EmekC/abf-mod-editor-mcp` only, through `ABFC_BACKEND_DIR`. Two branches of that repository matter; abfc does not commit to, merge or edit either.

| Branch | What it adds | Used for |
| --- | --- | --- |
| `abfc-p1-backend` | `abfc_tools.py` with the `abfc_extensions` and `reflect` tools, `editor/bpkit/reflect.py`, `editor/bpkit/reflectparse.py`, compile-message node references, `seconds` in read runs, `ABFC.md`; edits to `server.py`, `editor/bpkit/jobs.py`, `headless.py`, `headless_tools.py`. The new tools are opt-in: abfc starts the server with `ABF_ABFC_TOOLS=1`. | `abfc stubs` (reflect), compile errors mapped to nodes (`compile_node_refs`) |
| `abfc-wildcard-pins` | `backend_info` tool (protocol 1, `capabilities.pinTypes`, `bpApply.features`), node field `pin_types`, automatic typing of the cast `Object` pin (`cast_object_pin`), `map:` types | the native single-apply route |

- Apply order: the two branches change `server.py` in separate hunks, so both apply to `main` with plain `git apply` in either order.
- Capability gate: `pinTypes` needs `backend_info` to be listed, `capabilities.pinTypes === true` and `pin_types` in `bpApply.features`; `castObjectPin` needs `cast_object_pin` in the features.
- Without `backend_info` (the p1 branch alone, or an older server): warning ABFC4012, fallback route, `castObjectPin` false. This is the route the live run on the p1 branch uses.
- Known gaps in `abfc-wildcard-pins`, none of which Phase 1 reaches (review nits): `map:text` keys pass validation but do not compile; `exec` inside containers passes validation but does not compile.
- `mod_audit` audits the real mod, not the stage (`stageAudit: false`), reported as ABFC7003. Live, its hidden-desktop mod picker did not select the mod in two runs (see EC6).
- Native-route run: a temporary detached worktree of the MCP repository at the p1 base commit, with the wildcard-pins diff against that base and then the p1 working-tree diff applied by plain `git apply` (both applied cleanly in that order); `python -m unittest tests.test_unit tests.test_abfc_backend` ran 125 tests, all green; `ABFC_BACKEND_DIR` pointed at that worktree for `doctor`, `build --resync` and `test`. The spec of the single apply carried `pin_types` on the two `Array_Length` call nodes and the `GetArrayItem` node only, none on the cast nodes. The worktree was removed afterwards; nothing was committed, no branch changed, and the wildcard-pins checkout was only read.
- Backend gap (EC3): the p1 backend's compile log lines end in `from Source: <asset path>` with no `:<graph>.<node>` part, so `compile_node_refs` returns no node and an Unreal compile error is shown at the event span (ABFC6002, `(node not identified)`) instead of at the offending expression. It needs a backend change that puts the node into the log line or the compile report.
- Backend gap (`mod_audit`): the hidden-desktop mod picker mounted a wrong mod (a different one each run) when the mods folder holds several mods.

## Final verdicts

| Criterion | Verdict | Reason if not met |
| --- | --- | --- |
| EC1 | Met (fallback route and native route) | |
| EC2 | Met (simulated edit on the stage) | A real editor edit cannot reach the generated graph in Phase 1: it exists only on the stage. |
| EC3 | Partial | The type error is exact at `file.ts:line:col`. The Unreal error is shown at the event span, not at the expression, because the backend's compile log has no node in `from Source:`. The VS Code Problems panel was not checked visually. |
| EC4 | Partial (simulated) | Needs a second Windows account (user name with a space, redirected Documents folder). |
| EC5 | Met (simulated by editing the lock) | |
| EC6 | Partial | Timings recorded and nothing published (met). The publish stub did not reach its documented exit codes live because the backend's `mod_audit` did not complete (exit 1, ABFC7002); the codes are verified offline. |
| Backend: reflect, extensions, compile node refs | Met on branch `abfc-p1-backend` (uncommitted) | Unreal compile errors reach the expression only once the log-line gap above is closed. |
| Backend: wildcard pin types | Met on the temporary integration backend | The branch `abfc-wildcard-pins` is not merged; a plain p1 backend uses the fallback route. |

## Open items

- Backend: add `:<graph>.<node>` (or a node field) to compile errors so Unreal compile errors point at the expression (EC3).
- Backend: fix the `mod_audit` mod picker so it selects the requested mod, then rerun `abfc publish --dry-run` and `abfc publish` live (EC6). Consider whether a non-completed audit should be a warning for `--dry-run`.
- Backend: commit or merge the two branches (user decision). Review nits on `abfc-wildcard-pins`: `map:text` keys and `exec` inside containers pass validation but do not compile.
- EC4 on a real second Windows account (user name with a space, redirected Documents folder).
- Visual check of the VS Code Problems panel for EC3.
- `docs/backend.md` (referenced in a few error fixes) is not written yet.
- Stage audit: `mod_audit` does not cover the staged copy, so map and struct capabilities stay off.
- Build time: the fallback route costs a failed first apply plus a raw apply (about 10-20 s per build); the native route needs the wildcard-pins branch merged.
