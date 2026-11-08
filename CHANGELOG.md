# Changelog

All notable changes to abfc are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

abfc uses semantic versioning for its command-line surface: the commands, their flags, the exit codes, the error codes, the `abf.config.json` schema and the decorators. A new config schema or a removed option is a major change. All `@abfc/*` packages share one version.

## [1.0.0] - unreleased

### Added

- Own fields may have a literal initializer (`Speed: float = 2.5`); it becomes the Blueprint variable's default and changing it updates the default in place (backend feature `variable_defaults`, else warning ABFC2084).
- Derived asset paths: a class gets its Blueprint asset path from its file and class name, with the `path:` keep-path quick fix (ABFC5012) for a moved file.
- `@mod/` imports for classes of the mod being built.
- Schema-2 `abf.config.json` and a user config file; `abfc init` creates a project and upgrades a schema-1 config.
- `@director` rows (class-manager rows), which need backend 2.5.0 or newer.
- `abfc lsp` (the language server) and a VS Code extension packaged as a `.vsix`.
- `abfc.exe` with the backend and Python bundled, a per-user installer and a zip; neither is code-signed.
- `abfc version` and `abfc --version`.
- `abfc build --drift`, which reads and drift-checks every owned asset.
- Automatic stage re-sync after an Unreal compile failure, and `--keep-failed-stage` to keep the failed graphs for inspection (build, test, publish).
- Release hygiene: allowlisted artifacts, an artifact scanner (names, user and build paths, dev folders, game-derived files), npm tarballs without source maps, lockstep versions, and CI workflows for pull requests and releases.
- Template literals where a string is expected (``KismetSystemLibrary.PrintString(`Count ${this.Count}`)``) or in a `const` without a type annotation: Format Text followed by To String (Text) (`const t: text = ...` stays plain Format Text). Backtick strings without substitutions are string literals. A template literal where a `name` or another type is expected stays ABFC2099, with a clearer message.
- Hardening, found by using abfc on real mods (details of every fix: [docs/known-issues.md](docs/known-issues.md)):
  - Renames and moves just work. A class whose file moved or whose name changed (also class and file together) renames its Blueprint asset with Unreal's own rename and reference fixup; a changed `extends` reparents the asset (same family) or creates it again (other family); a class that left TypeScript has its asset deleted when abfc created it; `abfc publish` carries the deletions. Needs backend 2.6.0 (`bp_asset_ops`, `bp_publish` deletions); older backends keep ABFC5012 and ABFC2048. Asset operations are sent in calls of at most 20.
  - TypeScript wins. A build never refuses because of an edit in the Mod Editor; it replaces what TypeScript describes and removes hand-made nodes, function graphs and variables from classes that are not hybrid (components, the widget tree, timelines, macros, dispatchers and interface graphs are kept). One warning per asset (ABFC5014) lists everything replaced or removed. `interface X extends X_Manual` (hybrid) opts a class out of the sweep. A mod changed outside abfc is re-synced on its own (ABFC4017). Class defaults of assets the editor saved are applied again.
  - `@director("Row", ClassManager.EntityDirector.X)` writes the row's gameplay tag and adds a missing tag to the mod's `Config/Tags` ini; known tags are offered as globals from `.abfc/tags.d.ts`.
  - A new director tag works after `abfc publish` with the Mod Editor open, without a restart. The backend registers the mod's tags in the open editor before it reloads the published row (capability `liveTags`; abfc prints `gameplay tags registered in the open Mod Editor`; ABFC7015 only when that fails and then names the tags), and a director row that the Mod Editor saved (and stripped of an unknown tag) gets its tag again at the next build. Needs backend 2.6.0.
  - `@director` on a class that does not derive from ActorComponent is warning ABFC2089: the game adds directors as components of its AI director, so an Actor-based director never started. The director docs now use ActorComponent and say how to see a director run in Play In Editor. `publish --json` reports `tagsRegistered`/`tagsUnregistered`/`tagsStrategy`/`tagsError`.
  - Engine parameters with a default are optional: `KismetSystemLibrary.PrintString("hi")`, `Delay()`, `GetPlayerCharacter()`; the node keeps Unreal's default. A short curated list of very common functions adds the K2 zero defaults (`bSweep`, `bTeleport`, `PlayerIndex`).
  - `abfc lsp` completes library functions and `@override` stubs for the parent's events.
  - One abfc run at a time per project (`.abfc/lock.json`).
  - New codes: ABFC1045, ABFC2048, ABFC2078, ABFC2079, ABFC2080, ABFC2081, ABFC2082, ABFC2083, ABFC2089, ABFC3012, ABFC4017, ABFC4018, ABFC4019, ABFC5014, ABFC5015, ABFC5016, ABFC5017, ABFC5018, ABFC7014, ABFC7015 (`docs/errors.md`).

### Changed

- Behaviour changes of the hardening release: the Mod Editor's edits to a class's assets no longer stop a build or publish (ABFC5001 to ABFC5004 and ABFC4020 are warnings in `abfc status`); a field removed from TypeScript is removed from the asset (ABFC5011); changing a field's type recreates the variable (ABFC2047 is a warning); `@event` on a method that overrides a parent member is error ABFC2078 with a quick fix; `abfc adopt` is deprecated (ABFC5015); ABFC5012 only reports an ambiguous or unsupported rename; every re-sync (explicit, automatic, after a failed compile) prunes the manifests to the stage, so ABFC5002 cannot loop; class defaults that a publish already carried to the mod are not applied or republished again after a re-sync, unless the editor saved that asset (or the re-sync was explicit); `mod.name` in another letter case than the plugin file is read as the file's spelling (ABFC1045); the stub generator is at version 0.5.0 (optional parameters), so ABFC3002 asks for `abfc stubs` once.
- Backend 2.6.0 is recommended (`abfc doctor` warns with ABFC4018 about what an older one lacks). The minimum stays 2.4.0: every new feature is gated on a capability (`assetOps`, `publishDeletes`, `gameplayTags`, `reflectDefaults`, `classManagerRowTag`, `variableDefaults`) and an older backend prints a clear warning or keeps the earlier behaviour.

- The tsserver plugin is retired in favour of the language server.
- ABFC4015 now reports the adapter's missing cross-wire entry; ABFC4012 stays "no backend_info".
- Lint: `no-unbounded-array-growth` accepts pushes in the one-time overrides `ReceiveBeginPlay`, `Construct` and `OnInitialized`; `rpc-misuse` no longer reports a client-from-client call inside a server RPC or a private method reachable only from one.

### Known issues

- `abfc publish --full` stops at gate 5 (ABFC7002) on the machine where it was tried: the audit's hidden Mod Editor shows the Epic/mod.io login window, which no wait or sign-in in a normal session resolved (two live runs, 60 s and 240 s). Build, test and the default publish do not need it; run the Asset Audit in the Mod Editor before an upload. See the troubleshooting guide, "The Epic login window of the stage audit".
- The backend gives the audit's hidden editor a private home whose `AppData\Local` folder is linked to the backend's own headless folder instead of the real Local folder, so a stored mod.io session cannot be seen there. A fix is recorded for the backend; whether a bypass flag for gate 5 is wanted is an open decision.
- There is no `abfc mv`; it is not needed with backend 2.6.0, where a moved or renamed file renames its asset on the next build. With an older backend a moved file stops the build with ABFC5012 and the quick fix keeps the old asset path.
- Function locals and changing the fields of an existing struct are not supported yet. A struct that leaves TypeScript stays in the mod (ABFC5018).
- After a published deletion the open Mod Editor's asset registry keeps listing the asset until the editor is restarted; the files are already gone.
- The full list of limitations and fixed problems is [docs/known-issues.md](docs/known-issues.md).
- The exe, installer and zip are not code-signed, so Windows SmartScreen warns on the first run.

### Requirements

- The Mod Editor with a mod created in it.
- Source install: Node 24 or newer and backend 2.4.0 or newer; `@director` rows need backend 2.5.0. Backend 2.6.0 (tag `v2.6.0`) is recommended: renames, deletions, director tags, optional parameters and variable defaults need it. `abfc.exe` bundles it.
