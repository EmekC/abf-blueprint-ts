# Command line reference

`abfc` is one executable with a handful of commands. This page lists every command, every option, the exit codes and the shape of the `--json` output. For a guided first run see [first-mod.md](first-mod.md); for what an `ABFCnnnn` code means see [errors.md](errors.md).

```
abfc <command> [options]
```

Run `abfc` without a command to print the usage text (exit 0).

| Command | Needs a project | Starts the backend | What it does |
| --- | --- | --- | --- |
| [`abfc init`](#abfc-init) | no | only for `abfc stubs` and `abfc doctor` at the end | Creates or updates a project and links it to a mod. |
| [`abfc doctor`](#abfc-doctor) | yes (except `--clean-runtimes`) | yes, when the settings are complete | Shows every discovered setting and its source, then the backend and its capabilities. |
| [`abfc stubs`](#abfc-stubs) | yes | yes | Reflects classes and mod assets through the backend and writes `.abfc/stubs/<profile>/`. |
| [`abfc check`](#abfc-check) | yes | no | Type-checks the project and lowers it, without touching the mod. |
| [`abfc build`](#abfc-build) | yes | yes | Applies the Blueprints to a private staging copy of the mod and compiles them in Unreal. |
| [`abfc test`](#abfc-test) | yes | yes | Builds, then runs the tests through the backend. |
| [`abfc status`](#abfc-status) | yes | yes | Shows the state of every owned unit and of the staged copy. |
| [`abfc adopt`](#abfc-adopt) | yes | yes | Records a hand-made event or engine override as owned by abfc. |
| [`abfc publish`](#abfc-publish) | yes | yes | Builds, then copies the built assets from the staging copy into the mod. |
| [`abfc lsp`](#abfc-lsp) | no | no | Runs the language server over stdio ([language-service.md](language-service.md)). |
| [`abfc version`](#abfc-version) | no | no | Prints the abfc version (also `abfc --version`). |

A command that needs a project looks for `abf.config.json` in the working folder and then in each parent folder, or in the folder given by `--project`. A project folder that sits inside a mod folder (a folder with a `*.uplugin` file above it) is refused with [ABFC1020](errors.md#abfc1020). A missing or invalid `abf.config.json` is [ABFC1021](errors.md#abfc1021).

## Global options

These options are accepted by every command.

| Option | Meaning |
| --- | --- |
| `--json` | Print one machine-readable JSON document instead of text (see [JSON output](#json-output)). |
| `--verbose` | Print more detail: the stack of an unexpected failure, and the warnings Unreal logged while compiling a build. |
| `--project <dir>` | The project folder (default: the working folder, then its parents). For `abfc init` it is the folder to set up when no folder is given as a positional. |

## Environment options

These options override what abfc discovers. They apply to every command that needs a project; precedence and the matching environment variables and config keys are in [config.md](config.md).

| Option | Meaning |
| --- | --- |
| `--editor-root <dir>` | The Mod Editor install folder. |
| `--mods-dir <dir>` | The folder that holds your mods (`Abiotic Factor Mods`). |
| `--mod-dir <dir>` | The folder of this project's mod, when it is not under the mods folder. |
| `--backend-dir <dir>` | The backend checkout (source install; the exe brings its own). |
| `--python <exe>` | The Python the backend runs with (source install; the exe brings its own). |
| `--headless-dir <dir>` | The folder where the backend keeps its hidden-editor profile; must not contain spaces ([troubleshooting.md](troubleshooting.md#user-names-with-spaces-and-the-headless-folder)). |

`abfc init` reads `--editor-root`, `--mods-dir`, `--backend-dir` and `--python` and stores the values you pass in the user config.

## abfc init

```
abfc init [dir] [--mod <name>] [--yes] [--no-stubs] [--mods-dir <dir>] [--editor-root <dir>] [--backend-dir <dir>] [--python <exe>]
```

Creates (or updates) the project in `dir` (default: `--project`, else the working folder), links it to a mod of your mods folder, writes the sample class and its test, then runs `abfc stubs` and `abfc doctor`. It works outside a project. Without `--yes` it asks questions and shows the files before writing them. A schema-1 `abf.config.json` is upgraded and the old file is kept as `.v1.bak` ([ABFC1031](errors.md#abfc1031)). The steps are in [first-mod.md](first-mod.md) and [config.md](config.md).

| Option | Meaning |
| --- | --- |
| `[dir]` | The project folder, as the first positional. |
| `--mod <name>` | The mod to link to (matched case-insensitively against the mods folder). |
| `--yes` | No questions and no confirmation. Needs `--mod` when the folder has no project yet ([ABFC1040](errors.md#abfc1040) to [ABFC1044](errors.md#abfc1044) are the "cannot ask" and "mod not found" errors). |
| `--no-stubs` | Do not run `abfc stubs` after writing the files. |

`init --json` result: `{project, mod, modsDir, editorRoot, files: [{path, action}], userConfig: {path, keys}, stubs, doctor}`. `files` lists what was written (or left alone) relative to the project; `userConfig.keys` names the machine-specific settings written to the user config; `stubs` and `doctor` are the exit codes of those two steps (`stubs` is `null` with `--no-stubs`).

## abfc doctor

```
abfc doctor [--deep] [--clean-runtimes]
```

Prints the project, the mod, the profile, the Node version, the install kind, then every setting with its winner and source (flag, env, project, user config, auto), then starts the backend and prints its version and capabilities. Warnings do not change the exit code; errors do. The backend is not started when Python, the backend folder or the headless folder is missing; the output says which.

| Option | Meaning |
| --- | --- |
| `--deep` | For `abfc.exe`: verify the unpacked runtime folder file by file by sha256 and repair it from the exe if it is damaged. Prints `none (source install)` for a source install. |
| `--clean-runtimes` | Delete the unpacked runtime folders of other abfc versions (the one in use is kept; folders in use are reported with [ABFC1051](errors.md#abfc1051) as a warning). Works outside a project and does nothing else. |

`doctor --json` result: `{settings, backend, install}` where `settings` maps `editorRoot`, `documents`, `modsDir`, `modDir`, `python`, `backendDir`, `headlessDir` to `{value, source}` (`value` is `null` when not found), `backend` is the backend's `backend_info` (see [backend.md](backend.md)) or `null`, and `install` is `{kind, abfcVersion, runtimeDir}` (`kind` is `exe` or `source`). With `--deep` there is also `runtimeCheck`: `{files, repaired}` or `null`. `doctor --clean-runtimes --json` result: `{removed, failed, skipped, kept}` (lists of folders, and the kept folder or `null`).

## abfc stubs

```
abfc stubs [--resync]
```

Asks the backend to describe the classes listed in `abf.config.json` (`stubs.classes`, `stubs.scriptClasses`), reads the hand-made assets of the mod and writes the TypeScript declarations into `.abfc/stubs/<profile>/` together with `stubs.lock.json`. The first run needs the network once, because the backend downloads the Blueprint filter. Run it again when the config's `stubs` section, the mod assets or the editor build change; `abfc check` and `abfc build` refuse stubs that no longer match ([ABFC3010](errors.md#abfc3010) explains the one `stubs` key that is ignored).

| Option | Meaning |
| --- | --- |
| `--resync` | When mod assets are read, first recreate the staging copy from the mod (see [`abfc build`](#abfc-build)). |

`stubs --json` result: `{dir, files, members, opaque, modAssets}` (`dir` is the profile folder; `files` and `members` count what was written; `opaque` lists types abfc could not describe; `modAssets` lists the hand-made mod assets that got stubs).

## abfc check

```
abfc check [--watch]
```

Type-checks the project, applies the subset rules, lowers every class to Blueprint graph units and compiles the tests. It does not start the backend and does not change the mod. Diagnostics print as `<file>:<line>:<col>: <severity> ABFCnnnn: <message>`, which editors and CI understand as a problem matcher.

| Option | Meaning |
| --- | --- |
| `--watch` | Stay running and check again after every relevant file change (`*.ts`, `tsconfig*.json`, `abf.config.json`, the manifests and the stub lock). Stop with Ctrl+C (exit 0). Cannot be combined with `--json`. |

`check --json` result (only when there is no error): `{assets: [{asset, units: [unit id]}], tests}` (`tests` is the number of tests found).

## abfc build

```
abfc build [--resync] [--drift] [--keep-failed-stage]
```

Compiles the project and applies only the units whose TypeScript changed to a private staging copy of the mod, then compiles the changed Blueprints in Unreal. Your mod is not changed; `abfc publish` copies the result. The first build creates the staging copy. A build that finds nothing to do prints "up to date".

| Option | Meaning |
| --- | --- |
| `--resync` | Recreate the staging copy from the mod before building. Unpublished staged work of every project that targets the same mod is discarded. Use it after you changed the mod by hand, or when abfc reports a conflict with the real mod ([ABFC4020](errors.md#abfc4020)). |
| `--drift` | Read and drift-check every owned asset, not only the changed ones. It finds edits made in the Mod Editor to units that did not change in TypeScript ([ABFC5001](errors.md#abfc5001)) at the cost of one read per asset. It does not change what is applied. Only `abfc build` accepts it. |
| `--keep-failed-stage` | After an Unreal compile failure keep the failed graphs in the staging copy for inspection. Without it abfc re-syncs the staging copy from the mod, which discards all unpublished staged work (like `--resync`), and the next build applies the units again. If that re-sync fails, abfc warns with [ABFC4016](errors.md#abfc4016) and you run `abfc build --resync` before the next build. Also accepted by `abfc test` and `abfc publish`. |

`build --json` result:

- applied: `{applied: [unit id], assets: [asset path], structs?, route, upToDate, removed?, removedOrphanTags?}`; `route` is how the backend wrote the graphs;
- nothing to do: `{applied: [], upToDate}`;
- compile failure: `{applied: [], compileFailed: true, stageResynced}`.

A compile failure exits 1; the Unreal messages are listed as `ABFC6xxx` diagnostics (see [errors.md](errors.md)).

## abfc test

```
abfc test [pattern] [--no-build] [--resync] [--keep-failed-stage]
```

Builds (unless `--no-build`), compiles the tests of the project and runs each one through the backend's game-test runner in a hidden editor. `pattern` selects tests whose name contains it. Tests that need the live HUD are skipped with a warning and listed as manual checks (the checklist is written to `.abfc/reports/manual-checks.md`).

| Option | Meaning |
| --- | --- |
| `[pattern]` | Run only the tests that match. |
| `--no-build` | Skip the build; the stubs lock is still checked. |

`test --json` result: `{tests: [{name, passed, ok, steps, seconds}], manualChecks?}`; each manual check is `{name, file, line, checklist}`. When the build ran and was up to date or applied, the test result replaces the build result in the document. A failed test is [ABFC6104](errors.md#abfc6104) (exit 1).

## abfc status

```
abfc status [--resync]
```

Reads every owned asset from the staging copy and prints one line per unit: `<asset> <unit> <state> <ir hash> <asset hash>`, then how many staged files differ from the mod. Editor edits to a unit abfc owns are reported as drift ([ABFC5001](errors.md#abfc5001)).

`status --json` result: `{units: [{asset, unit, state, irHash, assetHash}], staging: {changed, added, removed, conflicts}}`.

## abfc adopt

```
abfc adopt <asset> <unit> [--remove-node <name>]... [--yes] [--discard-editor-changes] [--resync]
```

Records a hand-made event (`UpdateTarget` or `event:UpdateTarget`) or engine override (`override:ReceiveTick`) of an existing Blueprint as owned by abfc, so that a class in TypeScript can take it over. It never applies anything. Without `--yes` it only prints what it would record and exits 3 with [ABFC5006](errors.md#abfc5006). A unit that abfc already applied is refused with [ABFC5007](errors.md#abfc5007) unless `--discard-editor-changes` is given.

| Option | Meaning |
| --- | --- |
| `<asset>` `<unit>` | The asset path and the unit to adopt (exactly two positionals). |
| `--remove-node <name>` | An extra node (comment boxes, unlinked nodes) that goes away with the unit. Repeatable. |
| `--yes` | Write the adoption. |
| `--discard-editor-changes` | Replace a unit abfc already applied with the hand-made version; the next build removes the old generated nodes. |

`adopt --json` result: `{asset, unit, entry, owned, extra, crossLinks, written}`.

## abfc publish

```
abfc publish [--dry-run] [--full] [--resync] [--keep-failed-stage]
```

Builds, then copies the built assets of the project's mod from the staging copy into the mod. The backend refuses to publish on compile errors, conflicts, locked files or an editor in the wrong state, and keeps a backup of every replaced file. When the Mod Editor is open it reloads the published assets in place; stop Play In Editor and save or revert unsaved assets first ([ABFC7005](errors.md#abfc7005)). Nothing is ever uploaded: uploading a mod is a separate step you do yourself.

| Option | Meaning |
| --- | --- |
| `--dry-run` | Print the would-publish list and stop before the copy. |
| `--full` | Run the release checks first, in this order, stopping at the first failure: 1 stubs lock, 2 check and Blueprint-filter hits, 3 build with `--drift` semantics, 4 tests, 5 the mod audit of the staged copy ([ABFC7002](errors.md#abfc7002)), 6 upload file check, 7 the would-publish list, 8 the copy. There is no `abfc audit` command: `abfc publish --full --dry-run` runs gates 1 to 7 without copying. |

`publish --json` result: with `--dry-run` `{changed, added, dryRun, full}`; after a copy `{published, backup, route, reloadedInPlace, dirtyAfter, reloadedReferencers, skippedDirty, dirtyPublished, compileErrorsAfter}`. `--timings` prints the time of each gate.

## abfc lsp

```
abfc lsp [--stdio]
```

Starts the language server on stdin and stdout. Standard output carries only the protocol; logs go to standard error. `--stdio` and the `--clientProcessId <pid>` that language clients add are accepted and ignored. See [language-service.md](language-service.md) for the editor setup.

## abfc version

```
abfc version [--json]
abfc --version
```

Prints `abfc <version> (<exe|source install>, node <version>)` and exits 0. It works outside a project. `--version` together with another command is a usage error (exit 2). With `--json` it prints one object `{"version", "install", "node"}` without the envelope described below.

## Performance options

| Option | Meaning |
| --- | --- |
| `--timings` | Print a table of the steps of the run after `abfc check`, `build`, `test` and `publish`. The same data is appended to `.abfc/runs.jsonl`. |
| `--cold` | Do not use the backend's warm session; every backend operation starts its own editor. Slower; for diagnosing a stuck session. Applies to `build`, `test`, `status`, `adopt` and `publish`. |

## Option summary

| Option | Applies to |
| --- | --- |
| `--json`, `--verbose`, `--project` | all |
| `--editor-root`, `--mods-dir`, `--mod-dir`, `--backend-dir`, `--python`, `--headless-dir` | all project commands (`init`: the first four, see above) |
| `--timings` | check, build, test, publish |
| `--cold` | build, test, status, adopt, publish |
| `--resync` | stubs, build, test, status, adopt, publish |
| `--drift` | build |
| `--keep-failed-stage` | build, test, publish |
| `--no-build` | test |
| `--dry-run`, `--full` | publish |
| `--yes` | init, adopt |
| `--discard-editor-changes`, `--remove-node` | adopt |
| `--watch` | check |
| `--mod`, `--no-stubs` | init |
| `--deep`, `--clean-runtimes` | doctor |
| `--version` | `abfc --version` only |
| `--stdio`, `--clientProcessId` | lsp (accepted, ignored) |

A flag the command does not use is ignored, except for the three that are refused with a usage error: `--drift` outside `build`, `--keep-failed-stage` outside `build`, `test` and `publish`, and `--watch` with `--json`. An unknown option is a usage error too.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. Warnings never change the exit code. |
| 1 | Your code or your project is wrong: TypeScript subset errors (`ABFC2xxx`), test and compile failures (`ABFC6xxx`), publish refusals (`ABFC7xxx` except 7005 and 7006), ownership problems that are not conflicts (`ABFC5008` and up), and the `abfc init` user errors `ABFC1040` to `ABFC1044` (nested project, no terminal, mod not found, no mods in the folder). |
| 2 | The setup, the stubs or the backend is wrong, or the command line is malformed: environment and config errors (`ABFC1xxx`), stub errors (`ABFC3xxx`), backend errors (`ABFC4xxx`), `ABFC7006`, an unexpected failure (`ABFC4002`), and every usage error (unknown option, unknown command). |
| 3 | A conflict that needs your decision: `ABFC1020` (project inside a mod folder), `ABFC4090`, ownership and drift conflicts `ABFC5001` to `ABFC5007` (an edit in the editor to something abfc owns, a dry adopt) and `ABFC7005` (publish refused because the editor is playing or has unsaved assets). |

When a command reports several errors the exit code is the highest of them. The exact code of every diagnostic is in [errors.md](errors.md).

## JSON output

With `--json` nothing is printed while the command runs. At the end one document is written to standard output:

```json
{
  "command": "build",
  "ok": true,
  "diagnostics": [],
  "result": { "applied": [], "upToDate": true }
}
```

- `command` is the command name, `ok` is true exactly when the exit code is 0.
- `diagnostics` holds every warning and error: `{severity, code, message, span?, asset?, tried?, fix?, data?}`. `span` is `{file, line, col, ...}`; `tried` lists where abfc looked (`[{source, detail}]`); `data` carries machine-readable facts for a quick fix.
- `result` is the command's result described above, or `null` when the command stopped before it had one (for example after a failed check).

Text-mode diagnostics go to standard error, informational lines to standard output. `abfc version --json` and `abfc lsp` do not use the envelope.

## Not built

- `abfc mv` does not exist. If you move or rename a class file, abfc stops with [ABFC5012](errors.md#abfc5012) and offers a quick fix that keeps the asset where it is with `path: "<its path below the mod>"` in the class decorator, so the move does not create a second asset or retire the first.
- `abfc audit` does not exist. Use `abfc publish --full --dry-run` to run gates 1 to 7 of the release checks without copying anything.
