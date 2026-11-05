# abfc: TypeScript to Blueprint compiler for Abiotic Factor mods (design, phase 1)

Status: draft for review. Phase 0 ran on 2026-11-05 and its results are in `docs/spike-results.md`. Facts marked **(verified in Phase 0, P<n>)** were confirmed on the cooked Mod Editor. Facts still marked **(unverified)** were not settled by a probe and are listed in the "Remaining (unverified)" section of the results.

Target: Mod Editor 1.5.0, engine `5.4.4-1050002+++DF+ABF`, Windows only. MIT, public, published as npm packages. The only supported backend is `https://github.com/EmekC/abf-mod-editor-mcp`. abfc depends on no other backend repository.

## 1. Goals and non-goals

Goals
- Write a mod's Blueprint logic as TypeScript classes. The `.ts` files are the source of truth, and Blueprint graphs are build artifacts.
- It works on any Windows machine with the Mod Editor installed. Nothing is hardcoded to one PC, and nothing derived from Deep Field content is committed or published.
- A plain CLI (`abfc`) runs from any terminal or VS Code task and starts the Python backend itself. MCP and Claude are optional.
- Errors, from the TS subset checker, the Unreal compiler or a failed test, are reported as `file.ts:line:col: error ABFCnnnn: message`.
- A swappable backend: the compiler emits a backend-neutral graph IR and never calls `bp_apply` directly.
- Coexistence: the compiler owns only what it generated. Hand-made graphs, components and widget layouts in the same asset are left alone, and manual edits to owned parts are detected and refused.
- A release gate: nothing reaches the real mod folder unless the build is clean, tests pass and the audit passes.

Non-goals (phase 1)
- C++, cross-platform support, or more than one Mod Editor build at a time. A new build means a new profile, not code changes.
- Uploading to mod.io. The user always does uploads in the editor.
- Widget designer layout as code. Layout stays in the designer (hybrid mode, section 13).
- Round-tripping hand-made Blueprints back into TypeScript (no decompiler).
- Closures, exceptions, Promises, `new` on plain classes, user-defined pure functions.

## 2. User-facing workflow

### 2.1 Layout

The mod project (the `.uplugin` folder, usually `<Documents>\Abiotic Factor Mods\<Mod>`) and the TS project are separate folders. `abfc init` refuses to create a TS project inside a mod folder: it walks up from the target and fails if any ancestor holds a `.uplugin`.

```
goodsoup-ts/                      # TS project, its own git repo
  abf.config.json                 # project config, committed, no machine paths
  package.json                    # devDependencies: @abfc/cli, typescript (exact), engines.node
  .nvmrc                          # 24
  tsconfig.json                   # strict, paths -> .abfc/stubs, plugin @abfc/ts-plugin
  eslint.config.js                # @abfc/eslint-plugin recommended
  src/
    SoupInfoRelay.ts              # @blueprint classes
    SoupInfoRelay.test.ts         # compiled to bp_game_test steps
  .abfc/                          # gitignored except manifest/
    stubs/<profileId>/...         # generated per machine (never committed)
    manifest/<asset>.json         # ownership + hashes (committed)
    sourcemap/<asset>.json        # IR id <-> TS span <-> real node name
    cache/                        # incremental build cache, env discovery cache
    runs.jsonl                    # timings of every build step
  .vscode/tasks.json, settings.json   # written by abfc init
```

`abfc init` writes `.gitignore` with `.abfc/stubs/`, `.abfc/cache/`, `.abfc/sourcemap/`, `.abfc/runs.jsonl`, `node_modules/`.

### 2.2 `abf.config.json` (project, committed)

```json
{
  "$schema": "./node_modules/@abfc/cli/schema/abf.config.schema.json",
  "mod": { "name": "goodsoupWagdD" },
  "sources": ["src/**/*.ts"],
  "stubs": {
    "classes": [
      "/Game/Blueprints/Characters/Abiotic_PlayerCharacter.Abiotic_PlayerCharacter_C",
      "/Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup.Deployed_PotOfSoup_C"
    ],
    "scriptModules": ["Engine", "CoreUObject", "UMG", "SlateCore", "AbioticFactor"],
    "modAssets": "all"
  },
  "backend": { "kind": "bp_apply", "minProtocol": 1 }
}
```

Machine-specific values (`editor.root`, `mod.dir`, `backend.serverDir`, `backend.python`, `headlessDir`) are allowed here but `abfc doctor` warns about them. Their normal home is the user config `%APPDATA%\abfc\config.json`, which has the same schema and is never committed.

### 2.3 CLI

| Command | Needs editor | What it does |
| --- | --- | --- |
| `abfc init [dir]` | no | Scaffold the TS project, `.vscode` tasks and settings (`typescript.tsdk` -> workspace TS so the plugin loads), `.gitignore`. Refuses inside a mod folder. |
| `abfc doctor` | no (yes with `--deep`) | Print every discovered path with its source (flag, env, config, auto) and the backend version and capabilities. `--deep` also runs one commandlet to read the engine version. |
| `abfc stubs` | yes | Generate `.d.ts` stubs from editor reflection for the current editor build (section 5). |
| `abfc check` | no | tsc, the TS subset checker, ESLint and lowering to IR. No backend. Fast, used by watch mode. |
| `abfc build` | yes | check, then stage, drift check, apply the changed units, compile report, update manifest and source map. |
| `abfc test [pattern]` | yes | build, then run `*.test.ts` as bp_game_test runs. |
| `abfc audit` | yes | mod_audit + check_upload on the staged copy. |
| `abfc publish [--dry-run]` | yes | The release gate (section 12), then bp_publish. Never uploads. |
| `abfc adopt <asset> <event\|function>` | yes | One-time takeover of an existing hand-made unit (section 8.4). |
| `abfc status` | yes | Drift report: owned units, their hashes, manual edits found. |

Global flags: `--json` (machine-readable output for scripts and AI front ends), `--editor-root`, `--mod-dir`, `--backend-dir`, `--python`, `--headless-dir`, `--verbose`. Exit codes: 0 ok, 1 diagnostics (user errors), 2 environment or backend failure, 3 refused by a safety rule.

### 2.4 VS Code

- Squiggles come from tsc plus `@abfc/ts-plugin`, which runs the same subset checker that `abfc check` uses.
- `abfc init` writes tasks `abfc: check` (watch), `abfc: build` and `abfc: test`, with a problem matcher for `^(.*\.ts):(\d+):(\d+): (error|warning) (ABFC\d+): (.*)$`.
- Unreal compile errors and test failures show up in the Problems panel at the TS line that produced the failing node (section 8.6).

## 3. Architecture and packages

npm workspaces monorepo `abf-blueprint-ts`, built with `tsc -b`, tests on `node:test`. No bundler, no native addons: every runtime dependency is pure JS so `bunx abfc` can work, but only Node 24 LTS is tested and supported. `package.json` has `engines.node: ">=24 <25"`, `.nvmrc` is `24`, and `typescript` is pinned to one exact version, chosen in Phase 0 from the JS-based 5.x/6.x line because the compiler API is needed: `6.0.3`, the highest stable 6.x (verified in Phase 0, P9). TypeScript 7.x exposes only `typescript/unstable/*` API subpaths, so it is not used until it has a stable programmatic API. The seam of section 3 compiles with `tsc -b` on this version. The npm scope `@abfc` is a placeholder (open question).

| Package | Role | Depends on |
| --- | --- | --- |
| `@abfc/runtime` | Ambient declarations users import: decorators (`blueprint`, `override`, `event`, `replicated`...), intrinsics (`cast`, `isValid`, `idiv`, `await`-able latent helpers), branded number types. Types only, no runtime code. | none |
| `@abfc/ir` | IR types, JSON schema, `renderT3D(node)`, hashing, validation. | none |
| `@abfc/env` | Config precedence, editor, mods folder, Python and backend discovery, profiles. | none |
| `@abfc/compiler` | Frontend (TS -> HIR), lowering (HIR -> IR), planner (IR + manifest -> passes), source maps. | `typescript`, `@abfc/ir` |
| `@abfc/backend` | `Backend` interface, MCP-over-stdio client, the `bp_apply`, `import_nodes` and `paste_graph` adapters. | `@abfc/ir`, `@abfc/env` |
| `@abfc/stubgen` | Reflection result -> `.d.ts` files plus stub lock. | `@abfc/backend`, `@abfc/env` |
| `@abfc/testkit` | `*.test.ts` recorder -> bp_game_test steps. | `@abfc/ir` |
| `@abfc/ts-plugin` | Language-service plugin that reuses `@abfc/compiler`'s subset checker. | `@abfc/compiler` |
| `@abfc/eslint-plugin` | Network and performance rules. | `@typescript-eslint/utils` |
| `@abfc/cli` | `abfc` bin. Orchestration and diagnostics printing. | all |

Pipeline:

```
.ts --frontend--> HIR --lower--> IR (assets, vars, units, nodes, wires)
                                  |
manifest + bp_read snapshot --planner--> ApplyPlan (ordered passes, only changed units)
                                  |
                       Backend.apply / compile / gameTest / audit / publish
                                  |
            node-name map + compile log --> source map --> file.ts:l:c diagnostics
```

Type-checker isolation: `packages/compiler/src/frontend/` is the only code that imports `typescript`. It turns the checked program into HIR, a small typed tree that holds resolved symbols, Blueprint types and source spans. Lowering, planning and backends never see a `ts.Node` or `ts.Type`. Replacing the frontend with a native TypeScript (tsgo / TS 7) API is then a change in one folder. The ts-plugin calls `frontend.checkSubset(program, file)`, the same function `abfc check` uses, so the subset rules have a single source of truth.

## 4. The TS subset and lowering rules

### 4.1 Classes and members

| TS | Blueprint |
| --- | --- |
| `@blueprint({path, parent?, replicates?, alwaysRelevant?, onlyRelevantToOwner?, netUpdateFrequency?, minNetUpdateFrequency?, tickInterval?, tickEnabled?, classManagerRow?}) class X extends Parent` | Blueprint asset at `path` (must be under `/<Mod>/`), parent class, class defaults applied in the class-defaults pass. `classManagerRow` creates or updates the DT_ClassManager mod row asset (Phase 2). |
| Field `Score: int = 10` | Member variable with that default. `@replicated`, `@editable`, `@transient` set flags. |
| `@override ReceiveTick(dt: double)` | `K2Node_Event` with `bOverrideFunction` (bp_apply `override`). |
| `@event Foo(a: int)` | `K2Node_CustomEvent` in `EventGraph`. `@event({server|client|multicast, reliable})` sets net flags (raw node props, Phase 2). |
| Undecorated method | Function graph (entry, result). Getters (`get x()`) become impure functions, or are inlined when they are a single expression with no side effects. |
| `interface BP_X extends BP_X_Manual {}` | Declaration merging with the stub of the asset's hand-made members, so TS sees members it does not own (section 8.4). |

### 4.2 Expressions and statements

- `&&`, `||`, `?:` and `??` lower to Branch nodes and merge points. Blueprint AND, OR and Select evaluate both sides, so `x !== null && x.foo` would read None. The rule holds everywhere in phase 1. A later optimization may use BooleanAND for operands proven pure and null-safe.
- Pure results: a pure node's output is recomputed for every consumer. When a pure call result (not a plain variable get or literal) has two or more consumers, it is stored in a temp variable first. Temps are owned member variables named `abfc_<unit>_t<n>` (transient, not replicated, not editable) in event graphs, and function locals in functions when the backend reports `functionLocals`. Otherwise functions also get member temps. bp_apply has no local-variable spec today.
- Numbers: branded `int`, `int64`, `byte`, `float`, `double` (Blueprint `real`/double). Literals are inferred from context. Mixing kinds needs an explicit conversion (`toDouble(i)`, `trunc(d)`). `/` on integer types is error ABFC2010 (use `idiv(a, b)`); `%` on ints maps to `Percent_IntInt`.
- `cast(x, T)` returns `T | null`. `if (c)`, `if (!c)` and `?.` on the result are wired to the cast node's success and `CastFailed` exec pins, not to an extra IsValid. `?.` on other values lowers to `KismetSystemLibrary.IsValid` plus Branch. A null path through `cast(a?.b, T)` merges into the cast-failed path.
- `isValid(x)` is a type guard that maps to `IsValid` plus Branch.
- `===`/`!==` map to the typed `EqualEqual_*`/`NotEqual_*` from stubs (object, name, int, double, bool, enum). `==` is error ABFC2011.
- Functions with ExpandEnumAsExecs outputs (such as `GetGlobalItemRow`, with `Valid`/`NotValid`) return a discriminated value: `const r = f(); if (r.exec === "Valid") {...}`. The compiler wires the branches to the exec pins. Using `r.exec` in any other way is an error.
- Loops: `for (const x of arr)`, `for (let i = 0; i < n; i++)`, `while`, with `break` and `continue`. They lower to Branch nodes plus a back-edge and an owned counter variable (a counter plus `Array_Length` and `Array_Get` for `for..of`). That avoids StandardMacros GUIDs and supports break and continue. Exec back-edges are accepted by bp_apply in both a function graph and the event graph, and a counter loop counted to 10 in a game test (verified in Phase 0, P4). The StandardMacros `ForEachLoop`/`ForLoop`/`WhileLoop` instance through a raw node stays a documented fallback, not planned. Loops inside `@override ReceiveTick` get an ESLint warning.
- `await latentCall(...)` (stub flag `latent`) is allowed only directly in `@event` and `@override` event bodies, and not inside loops (ABFC2030, ABFC2031). The code after the `await` continues from the latent node's completion pin.
- Arrays: `T[]` maps to Blueprint arrays. `.length`, `push`, `[i]` (typed `T | undefined` under `noUncheckedIndexedAccess`; the compiler requires a bounds check or `!`, and `!` is flagged by lint), `includes`, `indexOf`, `splice(i,1)`, `length = 0` (`Array_Clear`). These map to `K2Node_CallArrayFunction` and `K2Node_GetArrayItem`, which need native node kinds with explicit pin types (see 7.3; verified in Phase 0, P5).
- `Map<K,V>` and `Set<T>`: lowered only when the backend reports `containerTypes.map/set`. Otherwise error ABFC2040 is reported before anything launches (Phase 4 adds a parallel-array lowering). A `Map<name,int>` variable with `Map_Add` and `Map_Find` compiled and passed a game test in Phase 0 (P6) with a local `map:<K>:<V>` type-grammar patch, so `containerTypes.map` is capability false until a stage audit passes; compile and game test passed; it also needs that patch and wildcard-pin resolution for `Map_*` nodes to land in the backend. The audit criterion was not verified. Set was not probed in Phase 0; native Set needs a `set:` grammar probe, else parallel-array lowering.
- Struct literals of existing engine structs map to `Make<Struct>`, and member reads map to `Break<Struct>`, cached as pure results. Mod-defined `@struct` classes need UserDefinedStruct creation. Creation through the Python `StructureFactory`, use as a variable (full object path `<pkg>/S_X.S_X`) and a game test worked in Phase 0 (P7). Authoring the struct's fields is not possible from Python in this build and needs a backend extension. The audit and cook acceptance of a mod-defined struct is unverified, so `@struct` is capability false until a stage audit passes; compile and game test passed.
- Template strings map to `Concat_StrStr` chains, or to `FormatText` for `text`. `name`, `string` and `text` are distinct branded types.
- Compile errors with clear messages: closures and arrow functions (except as `@abfc/testkit` callbacks), `try/catch/throw`, Promises other than `await` on latent calls, `new` on non-Blueprint classes, generators, `any`, `eval`, spread of objects, optional parameters without defaults, recursion between `@event`s through `await`.

`tsconfig` is generated strict: `strict`, `strictNullChecks`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useDefineForClassFields`, with TS standard decorators (not `experimentalDecorators`). Decorators never run: the compiler reads them statically.

### 4.3 Example: Good Soup relay, `UpdateTarget`

The hand-made graph, read from the staged copy on 2026-11-05 (41 nodes in `EventGraph`, `K2Node_CustomEvent_3`), does this: `OwnerPC.K2_GetPawn` -> cast to `Abiotic_PlayerCharacter_C` -> read `BestInteractable_InteractA` -> cast to `Deployed_PotOfSoup_C` -> IsValid macro -> branch on `CanFillSoupBowl` -> compare with `LastTarget`/`LastRowName` (BooleanAND) -> set both -> `GetGlobalItemRow` (Valid/NotValid) -> break `AbioticInventoryItem` -> `AbioticConsumable` -> skip when hunger, thirst and buff count are all zero -> `ForEachLoop` over `Infos` -> `ShowSoup` -> `bLastVisible = true`. Every failure path calls `HideAll`. The first ones also clear `LastTarget`.

```ts
import { blueprint, event, cast, isValid } from "@abfc/runtime";
import { Actor } from "/Script/Engine";
import { GlobalItemHandleFunctionLibrary as Items } from "/Script/AbioticFactor";
import { Abiotic_PlayerCharacter_C } from "/Game/Blueprints/Characters/Abiotic_PlayerCharacter";
import { Deployed_PotOfSoup_C } from "/Game/Blueprints/DeployedObjects/Furniture/Deployed_PotOfSoup";
import type { BP_SoupInfoRelay_Manual } from "/goodsoupWagdD/SoupInfo/BP_SoupInfoRelay";

export interface BP_SoupInfoRelay extends BP_SoupInfoRelay_Manual {} // OwnerPC, LastTarget, Infos, HideAll...

@blueprint({ path: "/goodsoupWagdD/SoupInfo/BP_SoupInfoRelay" })
export class BP_SoupInfoRelay extends Actor {
  @event
  UpdateTarget(): void {
    const player = cast(this.OwnerPC?.K2_GetPawn(), Abiotic_PlayerCharacter_C);
    const pot = cast(player?.BestInteractable_InteractA, Deployed_PotOfSoup_C);
    if (!pot || !pot.CanFillSoupBowl) {
      this.HideAll();
      this.LastTarget = null;
      return;
    }
    const rowName = Items.Conv_GlobalItemToName(pot.ItemRow);
    if (pot === this.LastTarget && rowName === this.LastRowName) return;
    this.LastTarget = pot;
    this.LastRowName = rowName;
    const row = Items.GetGlobalItemRow(pot.ItemRow);
    if (row.exec !== "Valid") { this.HideAll(); return; }
    const c = row.Data.ConsumableData;
    if (c.HungerFill === 0 && c.ThirstFill === 0 && c.BuffsToAdd.length === 0) { this.HideAll(); return; }
    for (const info of this.Infos) {
      if (isValid(info)) info.ShowSoup(c.HungerFill, c.ThirstFill, c.BuffsToAdd, c.BuffsToRemove, true);
    }
    this.bLastVisible = true;
  }
}
```

What it lowers to (IR nodes, abbreviated):

```
ev   CustomEvent UpdateTarget
g0   VariableGet OwnerPC
v0   CallFunction KismetSystemLibrary.IsValid(g0)   ; from ?. (strictNullChecks forces it; the original
b0   Branch(v0)                                      ;   graph called K2_GetPawn on a possible None)
p0   CallFunction Controller.K2_GetPawn self=g0      ; pure
c0   DynamicCast -> Abiotic_PlayerCharacter_C (p0)   ; b0.else -> fail path F1
g1   VariableGet Abiotic_PlayerCharacter_C.BestInteractable_InteractA self=c0.AsAbiotic...
c1   DynamicCast -> Deployed_PotOfSoup_C (g1)        ; c0.CastFailed, c1.CastFailed -> F1
g2   VariableGet Deployed_PotOfSoup_C.CanFillSoupBowl self=c1.As...
b1   Branch(g2)                                      ; else -> F1
n0   CallFunction Items.Conv_GlobalItemToName(ItemRow)  ; 2 consumers -> cached:
s0   VariableSet abfc_UpdateTarget_t0 = n0
e0   EqualEqual_ObjectObject(c1.As..., LastTarget) ; b2 Branch(e0) -> then: e1 EqualEqual_NameName(t0, LastRowName); b3 Branch(e1) then -> return
...  VariableSet LastTarget, VariableSet LastRowName(t0), CallFunction GetGlobalItemRow (Valid / NotValid exec pins)
...  BreakStruct AbioticInventoryItem -> BreakStruct AbioticConsumable (cached: used by compare and by ShowSoup)
...  3 chained Branches for the && chain, loop (counter var abfc_UpdateTarget_i0, Array_Length, Array_Get, back-edge)
F1   CallFunction HideAll -> VariableSet LastTarget = None
```

Behavior matches the original, except for the extra IsValid on `OwnerPC`, which removes an "Accessed None" on unowned relays. The `&&` chains become Branch chains instead of BooleanAND. The existing caller (`K2Node_CallFunction_9` in RelayTick, which calls `UpdateTarget` by name) keeps working because the event name does not change. Pin names here (`CastFailed`, `ReturnValue`, `Valid`, `NotValid`, `Data`, `InHandle`, `RowHandle`) are the ones in today's export, and the stubs reproduce them byte-for-byte (verified in Phase 0, P1). Phase 0 also built and ran this slice against a staged copy (P3): the original unit is 41 nodes, the lowered one 51, and it compiled clean with the existing Verify 2 results unchanged and the `RelayTick` call still linked. The caller's `MemberGuid` stays stale after the event is replaced and still resolves by name. The real graph differs in detail from this example (no `OwnerPC` `IsValid`, a `StandardMacros` `IsValid` on the pot, and `Double` zero checks plus `Array_Length` ANDed); the spike followed the original data flow. The slice built only after the wildcard pins of the array and cast nodes were resolved (7.3).

## 5. Stubs: generation and versioning

### 5.1 What is generated

- `/Script/<Module>` (from `stubs.scriptModules`): every class, struct and enum with Blueprint-visible members. Function libraries become `declare namespace`s with static functions.
- `/Game/...` classes listed in `stubs.classes`, plus the closure of the types their members use, to a depth of 2. Deeper types become opaque `declare class X extends UObject {}` with a `@bpPath`.
- The mod's own hand-made assets (`stubs.modAssets`): one `<Asset>_Manual` interface per asset, holding only members the manifest does not mark as owned.
- Module specifiers are UE package paths (`"/Script/Engine"`, `"/Game/Blueprints/Characters/Abiotic_PlayerCharacter"`), mapped by `tsconfig.paths` to `.abfc/stubs/<profileId>/...`. Imports stay unambiguous and identical on every machine.

Each member carries JSDoc tags read by the compiler: `@bpPath`, `@bpPin` (real pin name when it differs from the TS name), `@bpPure`, `@bpLatent`, `@bpExecOutputs Valid,NotValid`, `@bpWorldContext`, `@bpDefaultToSelf`, `@bpNode K2Node_CallArrayFunction` (when the call needs a special node class), plus the tooltip. Functions the Blueprint filter blocks are kept and tagged `@deprecated Blocked by Blueprint filter: <rule>`, so VS Code strikes them through.

The filter tag is a warning, not an error. `blueprint_filter_check` has raised false alarms (a PlayerController cast, `IsLocalController`, `K2_GetPawn`) that the real `mod_audit` passed, and `UpdateTarget` uses `K2_GetPawn`. The profile holds a `filterOverrides` list of members that `mod_audit` has passed despite a filter match. Each entry is `{parent, member, reason}` or, for a cast, `{cast, reason}`. Members without an override get `@deprecated Blocked by Blueprint filter: <rule>`, members with one get `@bpFilterOverride <rule>` instead, and a class that resolves to Block carries `@bpCastFilter` (verified in Phase 0, P2: three blocked references, all in the relay, 0 `@deprecated` left once the overrides are applied). The audit in the release gate is the only hard filter check.

### 5.2 How reflection works (verified in Phase 0, P1)

A new backend op `reflect` runs in a hidden commandlet:
1. Enumerate members. `unreal.load_class` loads `/Game` Blueprint classes (no `load_asset`). In this build `unreal.Function` and `unreal.Property` do not exist, so UFunctions come through `unreal.ObjectIterator(unreal.Field)` filtered by `get_outer() == cls` (real FNames), and the super chain is not walkable from Python. Property names with real FNames come from the output pins of a `K2Node_GetClassDefaults` node whose `Class` pin names the class (the class must be preloaded the way bp_apply's `objects` map does it); that also returns inherited properties. The Python wrapper's `dir()` mapping and the property-chain walk with per-build offsets were not needed and are kept only as fallbacks if the node route breaks on a new build, under the same discover-or-refuse rule bp_apply uses. Nothing under `/Game` is ever T3D-exported: that has crashed the editor.
2. Materialize pins. For each function, property get and property set, place a node in a throwaway scratch Blueprint (the same carrier mechanism bp_apply uses for templates), let the engine allocate pins, export the scratch Blueprint (a mod-side object, which is safe), and parse the pins. That gives the exact pin names, directions, types, defaults, hidden pins, ExpandEnumAsExecs pins, purity (no exec pins) and latency (a `LatentInfo` pin), as the Blueprint editor would create them. The scratch Blueprint is never saved.
3. Metadata (tooltips, display names, categories) is best effort. The Python routes tried in Phase 0 returned no metadata, so stubs carry no tooltips for now (verified in Phase 0, P1). The node-based steps above do not depend on it. Cost: about 60 to 70 s for a cold reflect of the relay's two `/Game` classes plus the library classes (about 1064 members, estimated), once per game version.

### 5.3 Versioning

`.abfc/stubs/<profileId>/stubs.lock.json`:
```json
{ "generator": "0.1.0", "profile": "ue5.4.4-1050002", "engineVersion": "5.4.4-1050002+++DF+ABF",
  "modEditorVersion": "1.5.0", "editorFingerprint": "sha256 of exe size+mtime+Epic AppVersionString",
  "filterContentVersion": "<from the filter header>", "classes": ["..."], "createdAt": "..." }
```
Every `abfc check` and `abfc build` compares the lock with the current editor fingerprint and the compiler's profile:
- Fingerprint changed: `ABFC3001: stubs were generated for Mod Editor 5.4.4-1050002 (1.5.0) but the installed editor is <new>. Run "abfc stubs" to regenerate.` The build refuses, and `check` is a warning.
- No profile for the detected build: `ABFC3002: abfc 0.1.0 supports Mod Editor build 5.4.4-1050002 only; found <new>. Update abfc, or wait for a release with a profile for this build.`
- `stubs.classes` changed in the config: regenerate only the delta.

### 5.4 Per-build profile

`packages/env/profiles/ue5.4.4-1050002.json` holds every version-specific fact. Code reads facts only from the profile.
- engine version string, Mod Editor version, Epic `AppVersionString`, exe relative path
- minimum backend protocol, and backend capabilities expected for this build
- type mapping (`real` is double, `float` is a single-precision property), standard pin names (`execute`, `then`, `else`, `CastFailed`, `ReturnValue`)
- node class paths, and the StandardMacros asset path (fallback loops)
- `filterOverrides`, known limits (`PrintString` not logged, no live HUD hidden, user pure functions rejected), harness constraints
- default mods folder name `Abiotic Factor Mods`

## 6. The IR

### 6.1 Schema (TypeScript, in `@abfc/ir`)

```ts
export interface IrModule {
  irVersion: 1;
  profile: string;                      // "ue5.4.4-1050002"
  mod: string;                          // "goodsoupWagdD"
  assets: IrAsset[];
}
export interface IrAsset {
  path: string;                         // "/goodsoupWagdD/SoupInfo/BP_SoupInfoRelay" (always under /<mod>/)
  create?: { kind: "Blueprint" | "WidgetBlueprint" | "BlueprintInterface" | "UserDefinedStruct"; parent: string };
  classDefaults?: Record<string, string>;      // property -> T3D value text
  variables: IrVariable[];
  units: IrUnit[];                      // owned functions/events/overrides
  structFields?: IrVariable[];          // only for UserDefinedStruct
}
export interface IrVariable { name: string; type: IrType; default?: string; flags: VarFlag[]; origin: Span; temp?: boolean }
export type IrType = string;            // bp_apply type grammar: "int", "object:/Script/Engine.Actor", "array:name", "map:name:int" ...
export interface IrUnit {
  id: string;                           // "event:UpdateTarget"
  kind: "function" | "event" | "override";
  name: string;
  graph: string;                        // "EventGraph" for events, the function name for functions
  signature: { inputs: IrParam[]; outputs: IrParam[]; net?: "server" | "client" | "multicast"; reliable?: boolean };
  locals: IrVariable[];                 // honored when the backend has functionLocals; else hoisted by the lowering
  nodes: IrNode[];
  wires: IrWire[];
  origin: Span;
  hash: string;                         // sha256 of the canonical JSON of signature+nodes+wires (no positions)
}
export interface IrNode {
  id: string;                           // stable within the unit, derived from AST path: "n_if3_cast0"
  t3d: { class: string; props: string[] };    // authoritative node text without pins (pins are engine-allocated)
  sem?: SemanticTag;                    // optional hint so adapters can pick a native kind
  pinDefaults?: Record<string, string>; // raw T3D defaults
  pinObjects?: Record<string, string>;  // object/class pin defaults by path
  pos: [number, number];
  origin: Span;
}
export type SemanticTag =
  | { k: "call"; class?: string; function: string } | { k: "get" | "set"; name: string; class?: string }
  | { k: "event"; name: string } | { k: "override"; class: string; function: string }
  | { k: "branch" } | { k: "sequence" } | { k: "cast"; target: string } | { k: "self" }
  | { k: "spawn" } | { k: "create_widget" } | { k: "call_dispatcher" | "bind_dispatcher"; name: string };
export type IrWire = [from: `${string}.${string}`, to: `${string}.${string}`]; // output first; "entry"/"result" reserved
export interface Span { file: string; line: number; col: number; endLine: number; endCol: number }
```

Every node has `t3d` text, so the text-based backends (import_nodes, paste_graph) need nothing else. `sem` exists only so the bp_apply adapter can use its native `k` kinds, which handle class preloading and retargeting. When `sem` is absent, the adapter sends `k: "node"` with `class` and `props`. `renderT3D(node)` in `@abfc/ir` produces the full `Begin Object ... End Object` block (fresh NodeGuid, no pins) for text backends.

### 6.2 Pass ordering

The planner turns an `IrModule` plus the manifest into an `ApplyPlan` with ordered passes. Within each pass, assets are ordered so that callees come before callers (a topological order over cross-asset calls; a cycle is fine because of pass 2).

| Pass | Content | Why |
| --- | --- | --- |
| 0 create | New assets (and UserDefinedStructs) | Later passes reference them. |
| 1 declare | New and changed variables (incl. temps), dispatchers | Variables must exist before get/set nodes. |
| 2 shells | Function signatures (entry and result only), custom event nodes with no body, in all assets | Custom events and functions must exist and compile before callers, or calls are dropped silently (the paste_graph lesson). |
| 3 bodies | Remove the old nodes of changed owned units (by real name from the manifest), add the new nodes and wires, wire them to the shells | The shells are compiled by now. |
| 4 retire | Remove owned variables, functions and events no longer in source | A variable can be removed only after its nodes are gone. In bp_apply, `remove_variables` runs before graphs within one asset spec. |
| 5 defaults | `classDefaults` (tick interval, replication flags) | bp_apply `raw` python on the CDO, as in the Good Soup plans. |
| 6 tags | Ownership comment boxes (section 8.2) | Its own pass so a refused comment node cannot roll back logic. |

The backend compiles after every pass. A pass with nothing in it is skipped.

### 6.3 Layout

Lowering assigns positions: columns follow exec depth and pure nodes sit left of their consumer. Each owned unit gets its own region below the existing nodes, using the same placement rule bp_apply uses, so generated graphs stay readable when someone opens them in the editor.

## 7. Backend interface

### 7.1 Interface (in `@abfc/backend`)

```ts
export interface BackendCapabilities {
  protocol: number;                       // abf backend protocol version (handshake, not the server's semver)
  writers: Array<"memswap" | "import_nodes" | "paste">;
  headless: boolean;                      // no desktop, mouse, keyboard or focus
  needsOpenEditor: boolean;
  createKinds: Array<"Blueprint" | "WidgetBlueprint" | "BlueprintInterface" | "UserDefinedStruct">;
  containerTypes: { array: boolean; set: boolean; map: boolean };
  userPureFunctions: boolean;
  functionLocals: boolean;
  rawNodes: boolean;                      // arbitrary class + props node text
  replicatedEvents: boolean;
  classDefaults: boolean;
  multiPassPerAsset: boolean;             // same asset may appear in several passes of one transaction
  transactional: boolean;                 // whole plan applies or nothing is saved
  compileErrorNodeRefs: boolean;          // compile errors name the node (needed for line-level mapping)
  nodeNameMap: boolean;                   // returns IR id -> real node name
  reflect: boolean; gameTest: boolean; audit: boolean; publish: boolean;
  warmSession: boolean;                   // can keep one editor process across operations
}
export interface BackendInfo {
  id: "bp_apply" | "import_nodes" | "paste_graph";
  serverVersion: string; protocol: number; engineVersion: string; editorRoot: string; headlessDir: string;
  capabilities: BackendCapabilities;
}
export interface Backend {
  info(): Promise<BackendInfo>;
  stage(modDir: string, opts: { discardChanges: boolean }): Promise<StageReport>;
  stageStatus(mod: string): Promise<StageStatus>;
  read(mod: string, asset: string): Promise<AssetSnapshot>;        // drift detection, manual-member stubs
  apply(mod: string, plan: ApplyPlan): Promise<ApplyReport>;      // all passes; per-pass compile
  compile(mod: string, assets: string[]): Promise<CompileReport>;
  reflect(req: ReflectRequest): Promise<ReflectResult>;
  gameTest(mod: string, steps: TestStep[], opts: { map?: string; timeoutSeconds: number }): Promise<TestReport>;
  audit(mod: string): Promise<AuditReport>;
  uploadCheck(modDir: string): Promise<UploadCheckReport>;
  publish(mod: string, opts: { assets: string[]; dryRun: boolean }): Promise<PublishReport>;
  close(): Promise<void>;
}
export interface ApplyReport {
  ok: boolean; rolledBack: boolean; seconds: number; run: string;
  passes: Array<{ pass: number; ok: boolean }>;
  nodeNames: Record<string /*asset*/, Record<string /*unit id*/, Record<string /*IR node id*/, string /*K2Node_X_N*/>>>;
  compile: { errors: CompileMessage[]; warnings: CompileMessage[] };
}
export interface CompileMessage { asset: string; message: string; node?: string /* real node name when available */ }
```

Before `apply`, the planner checks the plan against `capabilities` and fails with a clear error before anything launches, for example `ABFC4010: src/X.ts:12:3: Map<name,int> needs a backend with map support; bp_apply (protocol 1) has none.` Feature gates: maps and sets, user pure functions, UserDefinedStruct, raw nodes, replicated events, headless (tests need `gameTest`), and `transactional` (if it is false, the CLI resyncs staging after a failed build).

### 7.2 Transport

Every adapter talks to `abf-mod-editor-mcp`'s `server.py` the way `test_client.py` does: it spawns `python -I -X utf8 <serverDir>\server.py`, speaks MCP JSON-RPC 2.0 over stdio (one JSON object per line), and calls `tools/call`. There is no second protocol to maintain, and the same server stays usable from Claude. Arguments go in an argv array (never `shell: true`), and the child's environment gets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`. Large plans go through `spec_file` (a JSON file in `.abfc/cache/`) rather than inline arguments.

Version check: abfc does not rely on the server's semver alone. The backend exposes a read-only tool, `backend_info`, which returns `protocol`, `serverVersion`, `engineVersion`, paths and capabilities. The protocol number is a small integer that changes only when the tool contract changes, so abfc can tell whether the backend has the tools and capabilities it needs, and `abfc doctor` can print them. Version numbers are owned solely by `EmekC/abf-mod-editor-mcp`. If the tool is missing, or `protocol < minProtocol`, the result is `ABFC4001: abf-mod-editor-mcp at <dir> (server <version>) has no backend_info / protocol <n>; abfc needs protocol >= 1. Update it (see docs/backend.md).`

### 7.3 Adapter (a): `bp_apply` (today)

| IR | bp_apply spec |
| --- | --- |
| pass 0 `create` | `create: {class, parent, if_missing: true}` (UserDefinedStruct: needs an extension) |
| pass 1 variables | `variables: [{name, type, default, flags}]`, `dispatchers` |
| pass 2 function shells | `functions: [{name, inputs, outputs}]` with no nodes |
| pass 2 event shells | `graphs: [{graph: "EventGraph", add: [{k:"event", name, params}]}]` |
| pass 3 bodies | `functions[].nodes/wires` for new functions. Changed functions and events get `graphs: [{graph, remove: [old names], add, wires}]`, addressing the shell by the real name from `node_ids`. |
| pass 4 retire | `remove_variables`, `remove_functions`, `graphs[].remove` |
| pass 5 defaults | `raw: [{kind: "python", code}]` with a generated, fixed template (CDO `set_editor_property` / `set_actor_tick_interval`) |
| pass 6 tags | `graphs[].add` of `k:"node"` `EdGraphNode_Comment` |
| node with `sem` | the matching `k` (`call`, `get`, `set`, `event`, `override`, `branch`, `sequence`, `cast`, `self`, `spawn`, `create_widget`, dispatchers) |
| node without `sem` | `{k: "node", class, props}` |

Node classes that bp_apply's `k` kinds do not express and that go through `k: "node"`: `K2Node_CallArrayFunction` (array ops have wildcard pins), `K2Node_GetArrayItem`, `K2Node_BreakStruct`/`K2Node_MakeStruct`, `K2Node_FunctionResult` for early returns with values, `K2Node_CallParentFunction` (`super.X()`), `K2Node_SwitchEnum`/`SwitchName`/`SwitchInteger`, `K2Node_EnumEquality`, `K2Node_FormatText`, `K2Node_MakeArray`, `K2Node_TemporaryVariable` plus `K2Node_AssignmentStatement`, `K2Node_MacroInstance` (StandardMacros fallback; needs the macro graph GUID from reflection), and `K2Node_CustomEvent` with net flags (`FunctionFlags`). Phase 0 probe P5 results: `K2Node_BreakStruct` through `k:"node"` allocates correct pins and compiles. The scratch-template step also allocates the right pin names for `K2Node_CallArrayFunction` and `K2Node_GetArrayItem`, but their wildcard pins (`TargetArray`, `Array`, `Output`) stay undetermined after wiring, because bp_apply wires by text and never runs the engine's pin-type propagation, so the compile fails. Resolved pin lines placed in `props` are ignored. P3 and P6 showed the same for the `Object` pin of the native `cast` kind and for `Map_Add`/`Map_Find` pins. Fallback applied: the backend gets native kinds (`array_call`, `break_struct`, `make_struct`) that set pin types explicitly after template creation, and the same resolution for `cast` and `Map_*` nodes (and, untested, `Select`, `MakeArray`, macros); see section 14. Until then the adapter can use a two-phase route (verified in Phase 0, P3, P5, P6): apply, read the rolled-back `final_0.t3d`, patch the wildcard pins to the real types, and apply the whole graph as a `raw` graph block together with the `variables`. That is safe for existing hand-made nodes only because the text comes from the export and keeps them unchanged. The graph block is never written from scratch.

Other mappings:
- `multiPassPerAsset`: whether one bp_apply batch may list the same asset several times is **unverified**. If it may not, the adapter issues one bp_apply call per pass. bp_apply then rolls back only the failing call, so `transactional` is false and the CLI re-runs `staging_sync` with `discard_changes` on failure. That is safe because staging is abfc's build area and the real mod stays untouched until publish.
- Capabilities today: `headless`, `rawNodes`, `classDefaults`, `nodeNameMap` (`node_ids`), `gameTest`, `audit`, `publish` are true. `nativeNodeKinds` (native array, struct and cast kinds with explicit pin types; the capability name is a proposal for Phase 6), `containerTypes.map/set` (map: capability false until a stage audit passes; compile and game test passed; it needs the local patch `spike/backend-p6-map.patch` to land upstream), `userPureFunctions`, `functionLocals`, `compileErrorNodeRefs` (the parser drops the `from Source:` node path) and `warmSession` are false. Each false one is a small, separate backend extension (section 14).
- The memory-swap approach discovers offsets per build and refuses rather than guess. abfc shows that refusal as `ABFC4100: the bp_apply backend refused (<reason>) — this editor build may need a backend update.` It never retries with other settings.

### 7.4 Adapter (b): `import_nodes` (future)

Only relevant if Deep Field exposes `FEdGraphUtilities::ImportNodesFromText(graph, text)` to Python in the mod kit. The server then gains a writer option (`bp_apply` with `writer: "import_nodes"`, or an equivalent tool), and nodes are imported from `renderT3D(node)` text, so the engine allocates pins as on a paste. Wires are applied after the import by pin name. Stage, compile, test, audit and publish are unchanged. The compiler does not change: the user sets `"backend": {"kind": "import_nodes"}`, or the adapter is picked automatically when `backend_info.writers` includes it. Capabilities are expected to match bp_apply, minus the offset fragility (`writers: ["import_nodes"]`).

### 7.5 Adapter (c): `paste_graph` (fallback)

It uses the open, visible editor: function and variable shells through editor Python (`BlueprintEditorLibrary`), and nodes as clipboard T3D through the existing `paste_graph` tool, one paste per pass (shells and custom events first, then bodies), with a fresh node-name prefix per paste. Capabilities: `headless: false`, `needsOpenEditor: true`, `transactional: false`, `nodeNameMap` only through a read-back. The CLI requires `--interactive-backend` and warns that it takes over the desktop clipboard and focus. It writes into the open mod, not into staging, so the CLI refuses it unless the user confirms that the mod is under version control or backed up. This is the last resort if bp_apply breaks after an editor update and no import_nodes exists yet.

## 8. Ownership, hash manifest and source map

### 8.1 What is owned

Owned: the units (functions, custom events, overrides) and the variables (including temps) declared in TS for an asset, plus the comment boxes that tag them. Everything else in the asset is left alone: hand-made graphs and nodes, components, the widget tree and layout, timelines, and variables not declared in TS.

### 8.2 Tags inside the asset

Each owned unit gets one `EdGraphNode_Comment` around its region: `abfc:owned unit=event:UpdateTarget src=src/SoupInfoRelay.ts ir=<sha8> — generated by abfc, edit the .ts file`. The tag is visible to anyone who opens the graph, survives in the asset, and lets `abfc status` rebuild ownership if the manifest is lost (it then asks the user to confirm). Comment nodes do not affect compile or audit (the existing Good Soup comments passed the audit).

### 8.3 Manifest (`.abfc/manifest/<asset>.json`, committed)

```json
{ "asset": "/goodsoupWagdD/SoupInfo/BP_SoupInfoRelay", "compiler": "0.1.0", "profile": "ue5.4.4-1050002",
  "units": [{ "id": "event:UpdateTarget", "graph": "EventGraph", "irHash": "sha256:...", "assetHash": "sha256:...",
              "nodes": ["K2Node_CustomEvent_12", "K2Node_CallFunction_77", "..."], "tag": "EdGraphNode_Comment_31" }],
  "variables": [{ "name": "abfc_UpdateTarget_t0", "type": "name", "hash": "sha256:..." }] }
```

`assetHash` is computed from the read-back of the unit: the nodes' class and member references, pin defaults, links between owned nodes, links from owned to foreign nodes (by foreign node name and pin), sorted. Positions, GUIDs and comment sizes are excluded, so moving nodes is not an edit.

Drift check (every build, before apply): `read()` each asset with owned units, recompute `assetHash`, and compare.
- Equal: the unit is safe to replace.
- Different: `ABFC5001: BP_SoupInfoRelay event UpdateTarget was edited in the editor since the last build (3 nodes changed, 1 link added). abfc will not overwrite it. Undo the edit in the editor, or move it into src/SoupInfoRelay.ts and run "abfc adopt ... --discard-editor-changes".` There is no silent force flag.
- An owned node is missing: same error (`ABFC5002`).
- A foreign node links into an owned unit (for example a hand-made call to `UpdateTarget`): allowed, and recorded so the link is restored after replacement. The call references the event by name, so recreating it keeps the link valid.

### 8.4 Adoption and hand-made members

- `abfc adopt <asset> <unit>` takes over an existing hand-made unit once. It computes the nodes reachable only from that unit's entry (exec plus the pure nodes feeding them), refuses if any of them is shared with another unit, shows the list, and on confirmation removes them in the same transaction that adds the compiled unit. The real mod keeps its pre-adoption state until publish, and bp_publish backs it up. This is how the Phase 1 slice replaces `UpdateTarget`.
- Hand-made members that TS code uses (`OwnerPC`, `HideAll`, `Infos`) come from the generated `<Asset>_Manual` interface through declaration merging, so they are type-checked and never duplicated by hand.

### 8.5 Source map (`.abfc/sourcemap/<asset>.json`)

`irNodeId -> Span` from lowering, and `realNodeName -> irNodeId` from `ApplyReport.nodeNames`. Mapping:
- A compile error with a node reference (needs backend capability `compileErrorNodeRefs`, i.e. returning the `from Source: ...:EventGraph.K2Node_X_N` part that the server parses today but drops) maps to the exact TS span.
- Without a node reference, it maps to the unit's span, with the message prefixed `(node not identified)`.
- A runtime error in a test (`Accessed None ... Node: <title> Graph: <graph> Function: <fn>`) maps to the unit, and to the node when the title is unique in the unit (unverified log format: Phase 0 captured no sample, because the harness logged no "Accessed None" line even for the original graph's null `OwnerPC` path).

Printed as `src/SoupInfoRelay.ts:14:5: error ABFC6001: [Unreal] <message>`.

## 9. Environment discovery and config

### 9.1 Precedence

For every setting: **CLI flag > environment variable > project `abf.config.json` > user `%APPDATA%\abfc\config.json` > auto-discovery.** `abfc doctor` prints the winner and its source for each one.

| Setting | Flag | Env | Auto-discovery |
| --- | --- | --- | --- |
| Editor root | `--editor-root` | `ABFC_EDITOR_ROOT`, then `ABF_EDITOR_ROOT` | Epic manifests `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` with `DisplayName` "Abiotic Factor Mod Editor" (the install folder has a random suffix), validated by the exe path from the profile. Then `Program Files\Epic Games\AbioticFactorModEdit*`. The same order as the backend's `paths.py`. |
| Documents | — | — | Known Folder `FOLDERID_Documents`. Node has no Win32 FFI without native addons, so (1) `backend_info` reports the server's `documents_dir()` (`SHGetFolderPathW`, follows redirection), and (2) without a backend, `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" /v Personal`, with `%VAR%` expanded. Never `%USERPROFILE%\Documents`. |
| Mods folder | `--mods-dir` | `ABFC_MODS_DIR` | `<Documents>\Abiotic Factor Mods` (folder name from the profile) |
| Mod dir | `--mod-dir` | `ABFC_MOD_DIR` | `<mods folder>\<mod.name>`, which must hold `<mod.name>.uplugin` |
| Backend dir | `--backend-dir` | `ABFC_BACKEND_DIR` | none in phase 1 (explicit is required). Later: `abfc backend install` puts a pinned release in `%LOCALAPPDATA%\abfc\backend\<version>`. |
| Python | `--python` | `ABFC_PYTHON` | `py -3` launcher, then `python` on PATH. Requires 3.9+. Rejects the Microsoft Store alias stub (`...\WindowsApps\python.exe`). |
| Headless dir | `--headless-dir` | `ABF_HEADLESS_DIR` (passed through to the server) | the server's default `%LOCALAPPDATA%\abf-mod-editor-mcp\headless` |

### 9.2 Robustness rules

- Paths are handled as strings and passed in argv arrays. No shell is used, so spaces are fine.
- The headless dir must have no spaces (the backend refuses one). A Windows user name with a space puts a space in `%LOCALAPPDATA%`. `abfc doctor` and `build` detect this before launching and print `ABFC1012: the headless folder "C:\Users\Jane Doe\AppData\Local\abf-mod-editor-mcp\headless" contains a space, which the Mod Editor launch cannot handle. Set ABF_HEADLESS_DIR (or "headlessDir" in %APPDATA%\abfc\config.json) to a folder without spaces, e.g. C:\abfc-headless.` Non-ASCII user names get the same advice as a warning (unverified whether UE launch args handle them).
- All files are read and written as UTF-8 (JSON with BOM tolerated on read). Log files from the editor may be UTF-16 (the server already handles this).
- Mods on another drive, OneDrive-redirected Documents, and localized Windows are covered by the Known Folder lookup and by the explicit override.
- Discovery results are cached in `.abfc/cache/env.json`, keyed by the editor fingerprint, and re-validated (file existence) on every run.

### 9.3 Error shape

Every environment error has a code, what was tried in order, and one concrete fix:

```
abfc: error ABFC1001: Abiotic Factor Mod Editor not found.
  tried:
    --editor-root           not given
    ABFC_EDITOR_ROOT        not set
    ABF_EDITOR_ROOT         not set
    abf.config.json         editor.root not set
    %APPDATA%\abfc\config.json  editor.root not set
    Epic manifests          no "Abiotic Factor Mod Editor" in C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests
    Program Files wildcard  nothing matches C:\Program Files\Epic Games\AbioticFactorModEdit*
  fix: install the Mod Editor from the Epic Games Launcher, or set "editor": {"root": "<folder>"} in %APPDATA%\abfc\config.json.
```

Code ranges: 1xxx environment, 2xxx TS subset and lowering, 3xxx stubs and profiles, 4xxx backend, 5xxx ownership and drift, 6xxx Unreal compile and tests, 7xxx release gate.

## 10. Incremental build and warm editor

- Unit-level incrementality: `cache/units.json` maps unit id to `irHash + stubLockHash + compilerVersion`. Only changed units, plus the shells of new units, go into the ApplyPlan. Unchanged assets are not touched. A change to a signature also re-plans that unit's callers in owned code (hand-made callers are recompiled by the engine).
- `abfc check` never launches the editor. In watch mode it reruns the frontend and lowering on change (target under 1 s for a mod the size of Good Soup).
- Staging: abfc runs `staging_sync` when `staging_status` shows conflicts or a real-mod change, and otherwise reuses the stage, so successive builds stack on it. A failed non-transactional build discards the stage and resyncs.
- Cold cost today: each bp_apply, compile report or reflect call launches its own commandlet (about 10 s of launch overhead per the server's notes, plus the work). `bp_game_test` launches a `-game` process, and `mod_audit` a hidden editor. Measured in Phase 0 (P8): one asset cold apply + compile report + game test took 58.6 s as built today (20.5 failed first apply + 11.9 + 11.6 + 14.6; 38.1 s once pin types are resolved up front), the full Good Soup Verify 2 run 38.8 s, and `mod_audit` 44.5 s. A cold reflect of the relay's classes took about 60 to 70 s (estimate) and happens once per game version. A failed first apply (wildcard pins) adds 10 to 20 s, so the adapter resolves pin types before the first apply. Warm editor stays in Phase 2.
- Warm editor (Phase 2, backend extension `warmSession`): the server keeps one hidden `-run=pythonscript` commandlet alive that loops over job files in a run queue (same job format, same Job Object, same `-userdir`), and reloads packages between jobs. abfc uses it when the capability is present and falls back to cold runs. Hidden runs share one `-userdir`, so all operations are serialized anyway.
- Every step's duration goes to `.abfc/runs.jsonl` (`{step, seconds, units, cold|warm}`), and `abfc build --timings` prints them.

## 11. Testing: `*.test.ts` -> bp_game_test

Test files run in Node, not in the game. `@abfc/testkit` records a step list: handles are opaque `$names`, so test code cannot branch on game values, and every `expect` becomes an `assert` step.

```ts
import { test } from "@abfc/testkit";
import { BP_SoupInfoRelay } from "./SoupInfoRelay";

test("unowned relay stops ticking and never builds UI", async (t) => {
  const relay = t.spawn(BP_SoupInfoRelay);
  t.expect(relay.call("GetActorTickInterval")).approx(0.1, 0.001);
  t.wait(1);
  t.expect(relay.call("IsActorTickEnabled")).equals(true);
  relay.call("UpdateTarget");                        // OwnerPC is None: must take the hide path
  t.expect(relay.get("LastTarget")).equals(null);
  t.expect(relay.get("bLastVisible")).equals(false);
  t.wait(17);
  t.expect(relay.call("IsActorTickEnabled")).equals(false);
});
```

- Steps map 1:1 to bp_game_test ops (`new`, `spawn`, `widget`, `call`, `get`, `set`, `find`, `wait`, `assert`, `python`). Member names are checked against the stubs, so a typo is a TS error. `call` uses the Python-side name (`get_actor_tick_interval`), which testkit derives from the stub's real name using the profile's naming rule (unverified for every case; `t.raw.call("snake_name")` is the escape hatch).
- Each step keeps the `Span` of its `t.*` call, so a failed assert prints `src/SoupInfoRelay.test.ts:9:3: error ABFC6101: expected false, got true (step 7)`.
- `test.liveHud(...)` marks tests that need `W_PlayerHUD_Main`. The hidden game has no live HUD, so these are skipped hidden with a warning and listed in a "manual checks" report. Widget injection into `W_PlayerHUD_InteractionPrompt_C` cannot be tested hidden. A PIE-based runner through the open editor is a later optional extra.
- `PrintString` is not logged in this build, so tests read state back with `get`, never from logs.
- The public repo's own tests use synthetic fixtures (made-up classes and reflection JSON) and no Deep Field content. The Good Soup end-to-end test runs only on a machine that has the mod, and lives in the Good Soup TS project.

## 12. Release gate (`abfc publish`)

In order, stopping at the first failure, and failing closed:
1. Stubs and profile match the installed editor (no ABFC3001 or 3002).
2. `abfc check` is clean (warnings allowed, except `@deprecated` filter hits outside `filterOverrides`, which are listed).
3. `abfc build` is clean: no compile errors in any changed asset, and drift is clean.
4. `abfc test` passes (all tests not marked `liveHud`).
5. `mod_audit` passes on the staged copy. If it cannot run (for example the Mod Browser tile click fails), the gate fails and prints the backend's reason. There is no bypass flag in phase 1 (open question 2).
6. `check_upload` has no errors (for example no `.md` files in the mod folder).
7. `bp_publish` with `dry_run`: print the exact file list. Then confirm (`--yes` in non-interactive use), then `bp_publish` for real with `assets` limited to assets that hold owned units or were adopted.

abfc never uploads to mod.io and never offers to.

## 13. Widgets (hybrid mode, Phase 3)

A `@blueprint({ path, kind: "widget" })` class extending a `UserWidget` stub owns only the graphs it generates. The widget tree and layout stay in the designer. The stub `<Asset>_Manual` exposes designer widgets marked `IsVariable` as typed fields. Compiler-made `create_widget` and `AddChild` calls work as in the relay. The `widget_tree` and `animations` features of bp_apply are not used in phase 1.

## 14. Backend work required (in EmekC/abf-mod-editor-mcp)

All items land in `EmekC/abf-mod-editor-mcp`. Each item is small and gated by a capability, and abfc works without the optional ones:
1. `backend_info` tool (required, protocol 1): versions, paths (`documents_dir`, headless dir, editor root), capabilities.
2. `reflect` op for stubs (required for `abfc stubs`).
3. Compile messages keep the `from Source:` node path (`compileErrorNodeRefs`).
4. Required for Phase 1 (from Phase 0 probes P5, P3, P6): native node kinds `array_call`, `break_struct`, `make_struct`, with pin-type resolution for every wildcard-capable node (array functions, `GetArrayItem`, `cast`, `Map_*`, and untested `Select`, `MakeArray`, macros). Gated by a capability.
5. Optional: map types in the type grammar (`map:<K>:<V>`, patch `spike/backend-p6-map.patch`, `set:` still refused), UserDefinedStruct creation and field authoring (Python can create the struct but not set its fields in this build, and mod struct types need the full object path), function local variables, `warmSession`.
6. `mod_audit` must audit the staged copy (in Phase 0 it mounted the real mod folder, so the P3, P6 and P7 audit results are not verified), and `bp_read` and reflect runs should return `seconds`.
7. Single backend: the headless tools (bpkit, staging, headless runs) already live in `EmekC/abf-mod-editor-mcp`, which is the one supported backend. abfc checks `protocol` through `backend_info`, and server version numbers are owned only by that repository.

## 15. Security and safety

- Never write `/Game`. The compiler rejects any `@blueprint` path not under `/<mod.name>/` (ABFC2001), and the backend refuses again.
- Nothing is written into mod folders except through `bp_publish` (Content only, backed up outside the mod, conflict- and lock-checked). The TS project, caches, manifests and logs live outside the mod. `abfc init` refuses inside a mod folder, and `check_upload` in the gate catches stray files.
- Nothing is published without the gate, and nothing is ever uploaded.
- No silent overwrite of manual edits (ABFC5001). No force flags in phase 1.
- Pass-5 class-default Python is generated from a fixed template with validated property names and values. User text never becomes Python code.
- Nothing derived from Deep Field content is committed or published: stubs, the filter list and reflection caches are per machine and gitignored, and the public repo uses synthetic fixtures only. Docs may name classes and members (Good Soup example).
- Run folders and logs can hold tokens (per the server README). abfc never copies them into the project, and prints paths, not contents.
- Hidden processes are owned by the server (Job Object). abfc closes the server's stdin on exit and kills its process tree on Ctrl+C.

## 16. Risks and open technical questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| bp_apply's memory swap breaks after a Mod Editor update (offsets, array layouts) | Builds stop | The backend refuses rather than guesses. The per-build profile records a new build. The swappable backend, paste_graph as fallback, and a feature request to Deep Field to expose `ImportNodesFromText` to Python. |
| Reflection cannot list properties of `/Game` Blueprint classes with real names | Stubs incomplete | Resolved in Phase 0 (P1): `K2Node_GetClassDefaults` pins give real names, 1064 members and 15/15 reference pin lists matched. Fallbacks in 5.2 stay for a future build. A last resort is a hand-maintained override file per profile, kept outside the repo. |
| Cooked editor strips function metadata (confirmed for the Python routes tried in Phase 0, P1) | No tooltips, `WorldContext`, `DefaultToSelf` | Pin materialization gets the essentials from the nodes themselves. Metadata is best effort. |
| `k:"node"` raw nodes leave wildcard pins undetermined (CallArrayFunction, GetArrayItem; also native `cast` and `Map_*`). BreakStruct works (confirmed, Phase 0 P5, P3, P6) | Arrays, casts, maps fail to compile | Native kinds with explicit pin types in `EmekC/abf-mod-editor-mcp` (section 14). Interim: two-phase raw-graph apply (7.3). |
| Exec back-edges for loops rejected | Loops | Not a risk: accepted in function and event graphs (verified in Phase 0, P4). StandardMacros stays as a documented fallback. |
| UserDefinedStruct creation works (verified in Phase 0, P7), but field authoring from Python is missing and acceptance by audit and cloud cook is unverified | Mod-defined structs | Backend extension for fields. If a later audit of the stage rejects the struct, only engine structs (already supported as `struct:<path>`) and ABFC2045. |
| Maps and sets refused by bp_apply (maps work with a local type-grammar patch, Phase 0 P6; Set was not probed in Phase 0), and untested in audit and cook | `Map`/`Set` | Land the map patch in the backend and check the audit on the stage. Set: needs a `set:` grammar probe, else parallel-array lowering (Phase 4). A failed map audit: parallel-array lowering (Phase 4). |
| User pure functions rejected by the engine | Getters | Impure functions or inlining (decided). |
| No live HUD in hidden runs | Widget injection untested | `liveHud` tests skipped with a manual checklist. Optional PIE runner later. |
| `mod_audit` depends on a fragile Mod Browser tile click | Gate cannot run | Fails closed with the reason. `ABF_PICKER_TILE` override documented. |
| Branch-only lowering makes graphs larger than hand-made ones | Readability, tiny perf cost | Layout regions, comment tags. Later the pure-operand optimization. |
| Temps as member variables in event graphs | Asset clutter | Owned, prefixed, transient. Later `K2Node_TemporaryVariable` (already used by the Good Soup plans). |
| Same asset listed several times in one bp_apply batch (unverified) | Atomicity | One call per pass plus a resync on failure. |
| Replacing an owned function whose signature changed: hand-made callers may break between passes (unverified) | Callers lose links | Keep the graph and replace the body when the signature is unchanged. On a signature change, warn and re-check foreign callers after compile. |
| Backend extensions (section 14) are late | Optional features and stubs missing | They are all in `EmekC/abf-mod-editor-mcp`, under the same owner. abfc gates each one by capability and checks `protocol`. |

## 17. Open questions for the user

1. npm scope and package names: is `@abfc/*` acceptable (availability unchecked), and is the CLI name `abfc` final?
2. Release gate when `mod_audit` cannot run (fragile Mod Browser tile): fail closed with no bypass (current design), or allow `--no-audit` with a loud warning, since the upload runs the real audit anyway?
3. Manifest location: committed in the TS project (current design), so ownership travels with the source. Is the mod folder itself under version control anywhere, so the two can stay in step?
4. Backend versioning: resolved. The user decided to use `EmekC/abf-mod-editor-mcp` entirely, with nothing from the original maintainer and no dependency on other repositories. The `backend_info` protocol number is kept as a capability check, and version numbers are owned by that repo.

## Credits

`abf-mod-editor-mcp` was originally created by theelites11gamer (https://github.com/theelites11gamer/abf-mod-editor-mcp, MIT) and extended with the headless Blueprint tools by DezionDev. abfc depends only on `EmekC/abf-mod-editor-mcp`.
