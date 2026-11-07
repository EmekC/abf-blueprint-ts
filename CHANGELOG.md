# Changelog

All notable changes to abfc are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

abfc uses semantic versioning for its command-line surface: the commands, their flags, the exit codes, the error codes, the `abf.config.json` schema and the decorators. A new config schema or a removed option is a major change. All `@abfc/*` packages share one version.

## [1.0.0] - unreleased

### Added

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

### Changed

- The tsserver plugin is retired in favour of the language server.
- ABFC4015 now reports the adapter's missing cross-wire entry; ABFC4012 stays "no backend_info".
- Lint: `no-unbounded-array-growth` accepts pushes in the one-time overrides `ReceiveBeginPlay`, `Construct` and `OnInitialized`; `rpc-misuse` no longer reports a client-from-client call inside a server RPC or a private method reachable only from one.

### Known issues

- `abfc publish --full` can stop at gate 5 (ABFC7002): the audit's hidden editor may wait for an Epic login. Build, test and the default publish do not need it.
- Function locals and changing the fields of an existing struct are not supported yet.
- The exe, installer and zip are not code-signed, so Windows SmartScreen warns on the first run.

### Requirements

- The Mod Editor with a mod created in it.
- Source install: Node 24 or newer and backend 2.4.0 or newer; `@director` rows need backend 2.5.0.
