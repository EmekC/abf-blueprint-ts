# Phase 2 results

Status: Phase 2 run complete on Good Soup (2026-11-06). The relay and the director are entirely in TypeScript and built by abfc onto the STAGED copy. EC1, EC2, EC4 and EC5 are met, EC3-P1 (error mapping) is met, EC3 (PIE) is partial. Nothing was published, nothing was uploaded, the real mod was not changed (sha256 of all 13 files identical before and after) and `bp_publish` was never called.

No path on any machine appears in this document: paths are written as settings (`ABFC_BACKEND_DIR`, `ABF_HEADLESS_DIR`, `<project>`, `<mod folder>`).

Backend: branch `abfc-p2-backend` of `EmekC/abf-mod-editor-mcp` (a separate worktree based on `origin/main`, uncommitted). abfc: this worktree, uncommitted. Test counts at the end of the run: abfc `npm run build && npm test` 217 pass (was 170 at the start of Phase 2; 213 before the review fixes), backend `unittest tests.test_unit tests.test_abfc_backend` 159 OK (was 125).

## Exit criteria

| Criterion | Evidence | Verdict |
| --- | --- | --- |
| EC1 all relay and director logic in TS; every hand-made graph adopted or deleted | Units in TS: relay `TryInitLocal`, `RelayTick`, `EnsureInjected`, `UpdateTarget`, `HideAll`, `CleanupUI`, `override:ReceiveTick`, `override:ReceiveEndPlay`; director `StartDirector`, `ScanPlayers`, `StopDirector`, `override:ReceiveBeginPlay`, `override:ReceiveEndPlay`. 12 adopts (13 to 14.5 s each; 26, 20, 44, 9, 10, 2, 2 nodes in the relay and 10, 30, 12, 2, 2 in the director), comment boxes and the orphan `K2Node_Self_0` removed with `--remove-node`. After the cold build, `bp_read` with pins and a T3D export of both assets: no hand-made `K2Node_CustomEvent`, `K2Node_Event` or comment remains. Relay: 6 custom events and 8 comments, all abfc ids; director: 3 custom events and 5 comments, all abfc ids; the only `K2Node_Event` nodes are the 2 abfc override events per asset (`bOverrideFunction=True`). 0 unlinked non-event nodes. `abfc status`: 13 units `clean`. | **Met** |
| EC2 class defaults from `@blueprint({...})` applied in pass 5; `classManagerRow` handled | Offline: template string tests, ABFC2061/2062, defaults plan item. Live (ad hoc `bp_game_test` reading the class default object, built stage): `replicates` True, `always_relevant` True, `only_relevant_to_owner` False, `net_update_frequency` 1.0, `min_net_update_frequency` 1.0, `get_actor_tick_interval()` 0.1 (instance 0.1). `tickInterval` persists through `set_actor_tick_interval`. `classManagerRow` is verified, not written (see open items). | **Met** (defaults); `classManagerRow` verify-only by design |
| EC3 PIE host and client table matches | Hidden equivalent run by the gate (`Verify3Hidden`, 17/20, and `Verify2`, 25/28, both with the same known-issue steps). The real 2-client PIE check needs the desktop editor on the real mod, which the hard rules forbid. | **Partial**: hidden rows match, PIE not run |
| EC4 `abfc publish --dry-run` exits 0 and `abfc publish` exits 3 after every gate step; `bp_publish` never called | Gate run 4: exit 0. `abfc publish`: all 7 gates passed, then `ABFC7001: publishing is disabled; nothing was copied into the mod.`, exit 3. Details below. | **Met** |
| EC5 warm incremental build of one changed unit under 30 s (median of 3) | 14.5, 14.3, 14.4 s, median 14.4 s (`build.total`). Breakdown below. | **Met** |
| EC3-P1 (Phase 1 criterion, closed here): an Unreal compile error shows at `file.ts:line:col` | Live: `src/SoupInfoRelay.ts:115:36: error ABFC6001: [Unreal] Can't connect pins A and Abfc Update Target T 0 : Integer is not compatible with Name.` (and 3 more at the same span). | **Met** |
| Drift ABFC5001 | Live: a simulated editor edit of one owned node, then `abfc status` prints `ABFC5001` at the unit; a build with a changed unit in that asset also stops with `ABFC5001` and applies nothing. See the softened behavior below. | **Met** |
| `npm run build && npm test` green; backend unit tests green | 213 pass, 0 fail; backend 159 OK | **Met** |

### EC1: hand-made graphs adopted

Adopt results (each exit 0, 13 to 14.5 s): relay `TryInitLocal` (26 nodes, with comment boxes 2, 4, 5, 9001, 9002 and 9003 removed), `RelayTick` (20), `EnsureInjected` (44), `HideAll` (9), `CleanupUI` (10), `override:ReceiveTick` (2), `override:ReceiveEndPlay` (2); director `StartDirector` (10, with comment boxes 0, 1 and 2 and the orphan `K2Node_Self_0` removed; its delegate link to the custom event is a recorded cross link), `ScanPlayers` (30), `StopDirector` (12), `override:ReceiveBeginPlay` (2), `override:ReceiveEndPlay` (2). `UpdateTarget` was already owned. The text of the hand-made comment boxes moved into TS `/** */` doc comments (no compiler effect before Phase 5/6).

### EC3: hidden PIE equivalent against the expected table

Expected PIE table (Good Soup `soup-instant-tooltip` Verify 3) against the hidden game (`abfc test Verify3Hidden`, one game, one player controller):

| Row | Expected in PIE | Hidden game | Match |
| --- | --- | --- | --- |
| Own relay (owner = player controller 0), `bIsLocalUI` | True | True | yes |
| Own relay, tick enabled | True | True | yes |
| Own relay, tick interval | 0 | 0 | yes |
| Own relay, tick group POST_UPDATE_WORK | POST_UPDATE_WORK | not readable: `primary_actor_tick` is not a Python property in the hidden game | known issue (ABFC6102, same reason as Verify 2) |
| Foreign relay (no owner), `bIsLocalUI` | False | False | yes |
| Foreign relay, tick enabled after the wait | False | False (wait 24 s) | yes |
| Foreign relay, tick interval | 0.1 | 0.1 | yes |
| Foreign relay, tick group PRE_PHYSICS | PRE_PHYSICS | not readable (same reason) | known issue |
| Infos / Prompts of 1 / 1 on a local relay | 1 / 1 | needs the HUD; not reproducible in a hidden game | not covered |
| Second player (client world), replication | table rows for the client world | one game, one player | not covered |
| Per-frame proof (`slomo 0.05`, 40 ticks, 30 or more distinct values) | pass | not reproducible | not covered |

Verify3Hidden result: 17 of 20 steps pass; the 3 failing steps are the tick group known issues. Verify2 (the existing relay test): 25 of 28, the same 3 known issues as in Phase 1. Director: `SoupInfoDirector.test.ts` passes 7/7 (`ScanPlayers` makes one relay for one player controller, `StopDirector` empties `Relays` and `TrackedPCs`).

### EC3 PIE procedure for the user

Run only after the user has published `BP_SoupInfoRelay` and `BPC_SoupInfoDirector` (abfc never calls `bp_publish`) and has fully restarted the editor and opened the mod by hand (closing a mod does not unload old assets). It is the Good Soup PIE host and client check, run against the abfc-built assets.

Preconditions: `editor_status` shows the mod open and no PIE. Close the "Message Log" window if it is open.

1. Set `PlayNumberOfClients` to 2 on the default object of `/Script/UnrealEd.LevelEditorPlaySettings` (`run_python`).
2. `play_in_editor` start with `wait_seconds` 30. The worlds are the `unreal.World` objects whose path contains `UEDPIE_0` (host) and `UEDPIE_1` (client).
3. On `UEDPIE_0`: `unreal.SystemLibrary.execute_console_command(w, 'open Facility_Office1?listen', unreal.GameplayStatics.get_player_controller(w, 0))`.
4. After about 8 s confirm the host world is not standalone, then on `UEDPIE_1` run `open 127.0.0.1:7777` the same way.
5. Wait at least 25 s. The unowned relays stop their tick only after 150 ticks of 0.1 s, which takes about 15 s at 60 fps and up to about 18 s at 35 fps.
6. For each world and each relay from `unreal.GameplayStatics.get_all_actors_of_class(w, relay_class)` print the owner, `bIsLocalUI`, `is_actor_tick_enabled()`, `get_actor_tick_interval()`, the tick group and the lengths of `Infos` and `Prompts`. Expected:

   | World | Relay | Owner | Local | Tick | Interval | Group | Infos / Prompts |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | Host | own | PC_0 | True | True | 0 | POST_UPDATE_WORK | 1 / 1 |
   | Host | client's | PC_1 | False | False | 0.1 | PRE_PHYSICS | 0 / 0 |
   | Client | own | its PC | True | True | 0 | POST_UPDATE_WORK | 1 / 1 |
   | Client | other | None | False | False | 0.1 | PRE_PHYSICS | 0 / 0 |

   The tick group column needs the property to be readable. In the hidden game `primary_actor_tick` is not a Python property (known issue), so read the group in PIE or skip the column and rely on the interval column.
7. Per-frame proof on the host world only. Run the console command `slomo 0.05` with world `pie`, then register a post-tick counter that records `RescanCooldown` of the local relay for 40 ticks. About 15 s later print the count and the number of distinct values, and unregister the callback. Pass: count 40 and 30 or more distinct values. A relay still ticking at 0.1 s gives 7 or fewer. Then `slomo 1`.
8. Director check (new in Phase 2): with 2 clients connected, the host has exactly one `BP_SoupInfoRelay` per player controller (2 relays on the host, owner PC_0 and PC_1), and after the client disconnects the next scan (about 1 s) removes its relay.
9. `play_in_editor` stop. Set `PlayNumberOfClients` back to 1. Do this even if a check failed.
10. User checks that no automated test can see: look at a soup pot (stats and buffs appear in the same instant as the pot name, vanish when looking away, no flicker when moving across two soups), as host, as client, and after dying and respawning.

The hidden-game equivalent, `abfc test Verify3Hidden`, reproduces the Local, Tick and Interval columns for the own relay and for a foreign (unowned) relay in one game. It cannot reproduce a second player, replication, the HUD (Infos / Prompts of 1 / 1) or the per-frame slomo proof.

### EC4: publish full gate

`abfc publish --dry-run --timings` (gate run 4, default environment): exit 0, 226 s wall. `abfc publish --timings`: exit 3 (`ABFC7001`) after the same seven gates, 224.7 s wall.

| Gate | Result | Seconds (dry run / publish) |
| --- | --- | --- |
| 1 stubs fingerprint | ok | 0.0 / 0.0 |
| 2 check and blocked members (ABFC7011) | ok: 13 units, 2 assets, 9 tests | 0.5 / 0.5 |
| 3 build | ok: up to date, 13 units unchanged | 0.3 / 0.3 |
| 4 tests | ok: 9 of 9 (Director 7/7, UpdateTarget 6/6 and 7/7, HideAll 4/4, CleanupUI 6/6, EnsureInjected 6/6, TryInitLocal 7/7, Verify2 25/28, Verify3Hidden 17/20; the failing steps are the known issues) | 184.9 / 184.0 |
| 5 `mod_audit` on the stage | ok | 39.5 / 39.0 |
| 6 upload file check | ok | 0.0 / 0.0 |
| 7 would-publish list | `BPC_SoupInfoDirector.uasset` (changed), `BP_SoupInfoRelay.uasset` (changed); nothing added or removed | 0.3 / 0.3 |

`bp_publish` was never called. Evidence: the tool allowlist refuses it before anything is sent; `publish.ts` has no call to it; `.abfc/runs.jsonl` has no occurrence; no backend run folder created during the publish runs contains a publish op (one apply from the test harness, nine game tests, one audit); the real mod hashes are unchanged.

Refusal (fail closed) evidence from the runs on the way to the pass:

| Run | Result |
| --- | --- |
| Gate run 1 | gate 4 failed on a flaky `Verify3Hidden` step (see bugs); gates 5 to 7 were not reached, as designed |
| Gate run 2 (test waits fixed) | gate 5 failed: `ABFC7002 mod_audit did not pass for <mod>: hidden process timed out and was killed` (420 s); gates 6 and 7 not reached |
| Gate run 3 (`ABF_PICKER_HOME=0`) | gate 5 failed: `ABFC7002 mod_audit did not pass for <mod>: picker mounted <other mod> instead of <mod>` (42.6 s, one retry); the mount check caught the wrong mount, nothing passed on the wrong mod |

### EC5: warm incremental build

Edit of one unit (`CleanupUI`, statement order, alternating), `abfc build --timings`, warm (the default), three runs:

| Run | frontend | backendStart | stage | read | apply.main | apply.tags | build.compile | build.total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.3 | 0.1 | 0.0 | 10.2 | 1.4 | 1.4 | 0.8 | 14.5 |
| 2 | 0.3 | 0.1 | 0.0 | 10.4 | 1.4 | 1.2 | 0.6 | 14.3 |
| 3 | 0.4 | 0.1 | 0.0 | 10.1 | 1.5 | 1.4 | 0.6 | 14.4 |

Median 14.4 s, under the 30 s target. The dominant cost is `build.read` at 10.1 to 10.4 s: the warm editor starts inside the server process and lives only as long as one abfc invocation, so every command that touches the editor pays one editor start (about 11 s); the export of the one changed asset is small. Apply, tags and compile together are about 3.5 s warm. Cold baseline for the same project (13 units, two assets): `build.read` 26.3, `apply.main` 15.3, `apply.tags` 15.6, `apply.defaults` 13.1, `build.compile` 13.9, `build.total` 85.1 s. Per operation, one unit warm against cold: apply 1.4 against 15.3, compile 0.6 to 0.8 against 13.9. A no-change build is "up to date" in 0.5 s. Wall time of a warm build is 18 s (process start included).

### Post-review re-check (warm reload check, staged copy only)

After the review fixes (backend: a warm package reload with an error is a failure and falls back cold; abfc: manifests keep `irHash: ""` until the compile passes, publish gate 3 reads every owned asset) the warm path was run again live on the staged copy, default environment, no `bp_publish`.

- `abfc build --resync --timings` from the restored stage: success in 21 s wall, `build.total` 18.4 s, every editor step warm. The following `abfc build --timings`: "up to date" in 0.5 s.
- Trivial edit of one unit (`CleanupUI`, two statements swapped): `build.total` 14.6 s (read 10.1, apply.main 1.5, apply.tags 1.4, compile 0.9), every step warm. Reverting the edit: `build.total` 13.8 s (read 10.0, apply.main 1.3, apply.tags 1.2, compile 0.6), every step warm. Neither run printed "warm reload failed" or "warm log incomplete", and every job result was ok. The warm path did not fall back cold, so the EC5 figure (median 14.4 s) stands.
- Observed return of `reload_packages` in the 5.4.4 Python build: a tuple `(bool, Text)`; the success value is `(True, Text(""))`. The job log line is `ABFMCP_WARM_RELOAD {"reloaded": 4, "unloaded": 0, "reload": "(True, Text(\"\"))"}`. The reload check accepts it, so a good reload gives no false "warm reload failed". The resync reload still logs the known stale-class compiler lines ("is not compatible with", "doesn't match the property"); they are filtered by design and the result is ok.
- Restore repeated: `staging_sync` with `discard_changes`, then `staging_status` shows `changed`, `added`, `removed` and `conflicts` all empty; sha256 of all 13 files of the real mod is identical to the value before the phase; no `UnrealEditor` or `AbioticFactor` process was left. The project manifests again describe the discarded stage, so the next build needs `--resync`.

### EC3-P1: Unreal compile error at `file:line:col`

A deliberate change of the profile's `equal.name` function to `EqualEqual_IntInt` (reverted afterwards) makes the comparison in `UpdateTarget` fail to compile. Build exit 1 in 16.8 s wall:

`src/SoupInfoRelay.ts:115:36: error ABFC6001: [Unreal] Can't connect pins  A  and  Abfc Update Target T 0 : Integer is not compatible with Name.` plus three more at the same span (B / Last Row Name, Last Row Name / B, Abfc Update Target T 0 / A). `bp_apply` rolled back (stage bytes identical before and after), so the stage stayed clean. Before the fix the same run printed a bare `ABFC6002` without a location (see bugs: T3D `ErrorMsg` escaping).

### Drift ABFC5001

A `bp_apply` edit of the owned `Subtract_IntInt` node in `TryInitLocal` (pin `B` set to 5). A build with no source change reported "up to date" (by design, see the softened criterion). `abfc status` printed `src/SoupInfoRelay.ts:31:3: error ABFC5001: BP_SoupInfoRelay event TryInitLocal was edited in the editor since the last build (1 node changed, 0 links added, 0 links removed). abfc will not overwrite it.`, exit 3. With a source change in another unit of the same asset, the build also stopped with `ABFC5001` at the same line and ran no `apply.*` step. Restored by `bp_apply` and `status` clean.

## Backend work (branch `abfc-p2-backend`, uncommitted)

| Item | What it does | Verified live |
| --- | --- | --- |
| `warmSession` | `warm_session {start,stop,status}`; one hidden commandlet per server process polls a queue folder, reloads the staged mod's packages before each job, runs the job through the cold dispatcher; fallback to a cold run on a dead process or timeout; `warm: bool` and `seconds` in results. The job log is cut at the reload marker; reload-phase lines go to `reload.log`. | Yes: EC5 numbers, warm apply 1.4 s against 15.3 s cold. The reload-log cut was needed and verified (see bugs). |
| Compile node refs | After `compile_blueprint` the compiled assets are exported and each message is matched to the node carrying the `ErrorMsg`; entries get `node`, `graph`, `node_from: "export"`. `unescape_t3d` unescapes `\n \r \t \' \" \\` and splits multi-message `ErrorMsg` values. | Yes: `ABFC6001` at `SoupInfoRelay.ts:115:36`. The unescape fix was needed (apostrophes in "Can't connect pins"). |
| `mod_audit` picker fix | The hidden editor runs with a private `USERPROFILE` (empty `Documents\Abiotic Factor Mods`), with junctions for `AppData\Local` and `AppData\Roaming` back to the real folders; mount check from the editor log (`picker mounted <other>`, one retry); the private-list tile is tried first (fixed coordinate); `stage: true` and `stageAudit` capability; result carries `audited_copy` and `mounted`. | Yes: gate 5 passes in 39 s, `mounted` equals the requested mod, 7 assets audited, 0 errors, 0 warnings. |
| Spawn and create-widget `ReturnValue` typing | In `set_default_object` (T3D builder), setting the `Class` pin of `K2Node_SpawnActorFromClass` or `K2Node_CreateWidget` also types the `ReturnValue` pin as that class. | Yes: the compile errors "Actor Object Reference is not compatible with ..." went away; exported pins show `ReturnValue` typed `BP_SoupInfoRelay_C` and `WBP_SoupInfo_C`. |

Backend unit tests: 125 at the start, 159 at the end (all green).

## Bugs found live and root causes

- Warm reload stale-class errors. The first warm build of the director failed with compile errors on `SpawnActor` and five `Relays` variable reads. Root cause: the errors were logged by `reload_packages` in the warm loop (between the begin and reload markers), before any import, and `apply_batch` counted every error on the target asset in the job's log as an apply failure. A truly cold build of the same sources compiled clean. Reordering the reload packages did not help; the fix cuts the job log at the reload marker.
- `--cold` did not clear an inherited `ABF_WARM_SESSION`. `spawnBackendServer` set the variable only for `warm === true`, so a shell with the variable set stayed warm. Fix: a pure `backendServerEnv` removes it when `warm === false`.
- T3D `ErrorMsg` escaping. The backend's message matching unescaped only `\"` and `\\`, so every message with an apostrophe or a newline ("Can't connect pins") matched no node, and abfc printed a bare `ABFC6002` without a location. Fix: single-pass unescape in `bpscan`, whitespace-only normalization in `_norm_msg`.
- Verify3Hidden flaky at 35 fps (wait 17 to 24). The unowned relay disables its tick after 150 ticks at 0.1 s. The hidden game runs about 35 fps, so a tick fires about every 4th frame (about 0.115 s) and 150 ticks take about 17.1 s, the same as the 17 s wait: a coin flip (2 failures in about 7 runs). Not a port bug. The failing assertion was the foreign relay's tick state, not `bIsLocalUI`. Fix in `Verify3Hidden.test.ts` and `Verify2.test.ts`: wait 24 s. The Good Soup PIE table has the same race at low fps.
- Picker hang and wrong mount. Two different causes. (1) With a redirected `USERPROFILE` and no `AppData` under it, the hidden editor hung in startup after the Zen/DDC init (no output for 420 s). Fix: junctions for `AppData\Local` and `AppData\Roaming`. (2) With the full Documents folder, the picker mounted a different mod from the user's mods folder (a different one each run). Fix: private mods folder, mount check from the log, one retry, and the private list's single tile tried first (the default click candidates hit empty space in the single-column list).
- Also found: the director test host. A component created with `outer=<level>` has no world, so `GetNumPlayerControllers` saw nothing (`Relays` length 0). Hosting it with `unreal.new_object(..., outer=<spawned actor>)` passes 7/7. Test fix only.
- Corrected during the run: a failed `bp_apply` does roll back (stage bytes identical before and after, verified with sha256). An earlier note said it did not; that came from the commandlet's inner `result.json`, not the MCP result.

## Timings

| Step | Cold (13 units, 2 assets) | Warm (1 unit) |
| --- | --- | --- |
| build.frontend | 0.3 | 0.3 |
| build.backendStart | 0.1 | 0.1 |
| build.stage | 0.0 | 0.0 |
| build.read | 26.3 | 10.1 to 10.4 (includes the warm editor start) |
| apply.main | 15.3 | 1.4 to 1.5 |
| apply.tags | 15.6 | 1.2 to 1.4 |
| apply.defaults | 13.1 | not part of a one-unit change |
| build.compile | 13.9 | 0.6 to 0.8 |
| build.total | 85.1 | 14.3 to 14.5 |
| test, per game test | about 14 (Verify2 32 to 42, Verify3Hidden 29 to 38) | the same (every test is its own `-game` process; the warm session is stopped before it) |
| tests, all 9 | 164 to 187 | the same |
| mod_audit (stage) | 39 to 40 | the same (a hidden editor, always cold) |
| publish, whole gate | 224 to 226 wall | |
| status / stubs / doctor | status 14.5 to 17 (reads the stage), stubs 36.6, doctor 0.5 | |

## Behavior deltas against the hand-made graphs

- `InitRetriesLeft`: natural TS (`this.InitRetriesLeft = this.InitRetriesLeft - 1; if (this.InitRetriesLeft <= 0) ...`). The original re-evaluates the pure subtraction after the set, so it stops one 0.1 s tick earlier. The 24 s test window covers both.
- `EnsureInjected`: the original evaluates all three operands of the OR (possible Accessed None); the TS short-circuits.
- `IsValid` on `OwnerPC` is not repeated before every use.
- Counted `for` loops and `for..of` use an owned counter variable `abfc_<unit>_i<n>`.

## Design deltas

See `design.md` (sections 4.1, 4.2, 6.1, 6.2, 7.1, 10, 12 and 17, updated in Phase 2): `@override` units, `EnumText` and `nameOf`, `createWidget` and `spawnActor`, ternary only as the whole right-hand side of an assignment, counted `for` and array mutation, `IrUnit.crossWires`, class defaults pass from a fixed template, `stageAudit`, `warmSession` as implemented, the `units.json` cache, the gate without `bp_publish` and with an abfc-native upload check.

## Open items and follow-ups

- Post-apply compile failure does not restore the stage. A failed `bp_apply` rolls back, but when `bp_compile_report` finds errors after a successful apply the build fails and the applied passes stay on the stage (manifests written, cache not, so the next build re-applies). The passes are not one transaction. Needs a backend restore tool (`transactional` stays false).
- Softened Phase 1 criterion: an unchanged-TS build no longer reads assets, so editor drift shows up in `abfc status` or on the next build that changes a unit in that asset (a build with a changed unit in the same asset also finds it). Phase 1 EC2 ("the next build fails with ABFC5001") holds only when the build re-plans a unit of that asset. Decide whether a periodic or `--check-drift` read is wanted.
- Adoption and delegates (review fix): `abfc adopt` refuses (ABFC5005) an event whose delegate is used by a hand-made node outside every owned or adopted unit, and treats only delegate pins (not event parameter pins) as cross links. Adopt the unit that holds the delegate user first (Good Soup: `StartDirector`, then `ScanPlayers`). A hand-made delegate user added after the adoption is not detected until the build replaces the event.
- The private-list tile of the mod picker is a fixed window coordinate (relative position in the window), tried first when the redirect is on. A different window size or UI change breaks it; `ABF_PICKER_TILE` overrides it.
- `classManagerRow` is verified, not written. The build reads the row and warns ABFC2070 if it does not reference the class. Writing rows needs a non-Blueprint save path (Phase 6).
- Game tests get no warm benefit (about 14 s each, a separate `-game` process). A suite of 9 tests costs about 3 minutes.
- The gate's tests step runs every test: there is no `liveHud` marker yet (Phase 3).
- The upload check is only a partial copy of the backend's `check_upload` (file rules: shippable types, `Saved`/`Intermediate`/`Binaries`/`DerivedDataCache`, `.md`). There is no `/Game` reference check (needs the retail asset list).
- `abfc doctor` warns ABFC1030 on Node 26 (Node 24 is pinned).
- The warm editor lives as long as one abfc invocation, so each command pays one editor start (about 10 s). A persistent warm server across commands would remove it.
- Dependency re-planning on a signature change is implemented only for delegate owners; a changed callee signature changes the caller's IR hash through its call wiring.
- Backend branch `abfc-p2-backend` and the abfc worktree are uncommitted (user decision).
- Stage restore (step 21): done. `staging_sync` with `discard_changes` for the mod, then `staging_status` shows `changed`, `added`, `removed` and `conflicts` all empty; sha256 of all 13 files of the real mod is identical to the value before the phase; no `UnrealEditor` or `AbioticFactor` process was left. The manifests in the project still describe the stage that was just discarded, so the next build replays the adoptions per the Phase 1 manifest rules (a resync build, `abfc build --resync`).
