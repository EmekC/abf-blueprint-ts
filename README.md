# abfc

abfc is a TypeScript-to-Blueprint compiler for Abiotic Factor mods. You write a mod's Blueprint logic as TypeScript classes, and abfc generates the Blueprint graphs in the mod through a headless Mod Editor backend. The `.ts` files are the source of truth, and the graphs are build artifacts.

Repository: https://github.com/EmekC/abf-blueprint-ts

## Status

Version 1.0.0, a pre-release until the `v1.0.0` tag is published: the code, the documentation and the release pipeline are complete, and the first release is checked on a clean machine before it is announced. The release notes are in [CHANGELOG.md](CHANGELOG.md). Known limits (function local variables, changing the fields of an existing struct, the stage audit of `abfc publish --full`) are listed there and in [docs/design.md](docs/design.md).

## Install

The newest release is on https://github.com/EmekC/abf-blueprint-ts/releases. Pick one of:

- **Installer**: `abfc-setup-<version>.exe`. Per user, no administrator rights, optional PATH entry and VS Code extension.
- **Zip**: `abfc-<version>-win-x64.zip`. Unpack it anywhere and run `abfc.exe`.
- **npm**: the `@abfc/*` packages are for people who build abfc from Node (`npm install -g @abfc/cli`); this needs Node 24 or newer and a backend checkout. See [docs/install.md](docs/install.md#source-install).

`abfc.exe` carries its own Node, Python and backend, so the installer and the zip need nothing else but the Mod Editor. Then:

```
abfc --version
abfc init
abfc doctor
```

[docs/install.md](docs/install.md) has the details (SmartScreen, verifying a download, updating, uninstalling); [docs/first-mod.md](docs/first-mod.md) walks through a first mod.

## Documentation

- [docs/install.md](docs/install.md): install, update, uninstall, source install.
- [docs/first-mod.md](docs/first-mod.md): a first mod from `abfc init` to `abfc publish`.
- [docs/cli.md](docs/cli.md): every command, option, exit code and `--json` output.
- [docs/config.md](docs/config.md): `abf.config.json`, the user config and the environment variables.
- [docs/errors.md](docs/errors.md): every error and warning code, with cause and fix.
- [docs/troubleshooting.md](docs/troubleshooting.md): step-by-step help for common problems.
- [docs/backend.md](docs/backend.md): the backend (bundled in `abfc.exe`; abf-mod-editor-mcp 2.4.0 or newer, 2.5.0 for `@director` rows, in a source install): settings, capabilities and diagnostics.
- [docs/language-service.md](docs/language-service.md): the editors page: `abfc lsp`, the VS Code extension, watch mode.
- [docs/lint-rules.md](docs/lint-rules.md): the ESLint rules for tick cost, replication and RPC use.
- [docs/releasing.md](docs/releasing.md): how a release is built and published (for maintainers).
- [docs/design.md](docs/design.md): goals, workflow, compiler architecture, backend interface, safety rules and open questions.
- [docs/roadmap.md](docs/roadmap.md): the phased plan.
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

### Packages

| Package | Role |
| --- | --- |
| `@abfc/runtime` | types and decorators the TypeScript mod code imports (`@blueprint`, `@event`, `cast`, `isValid`) |
| `@abfc/testkit` | the `test` API for `*.test.ts` files, step serialization and result evaluation |
| `@abfc/ir` | shared data shapes, the IR, T3D text tools and hashing |
| `@abfc/env` | environment discovery, project config, diagnostics and exit codes |
| `@abfc/stubgen` | writes the `.d.ts` stubs and `stubs.lock.json` from reflection data |
| `@abfc/compiler` | TypeScript frontend, lowering to IR, ownership (manifest, drift, adoption, source map), build planner |
| `@abfc/backend` | the `Backend` interface, the `bp_apply` adapter and the two-phase wildcard fallback, MCP client |
| `@abfc/cli` | the `abfc` command: `init`, `doctor`, `stubs`, `check` (also `--watch`), `build`, `test`, `status`, `adopt`, `publish`, `lsp`, `version` |
| `@abfc/lsp` | `abfc lsp`: the language server (abfc diagnostics, lint rules, Blueprint-node hover, quick fixes) for any LSP editor ([docs/language-service.md](docs/language-service.md)) |
| `abfc-vscode` | the VS Code extension, a `.vsix` built with `npm run vsix`; not on the marketplace |
| `@abfc/eslint-plugin` | five lint rules for tick cost, replication and RPC use ([docs/lint-rules.md](docs/lint-rules.md)) |

### Build and test

```
npm install
npm run build
npm test
```

`npm run build` is `tsc -b` and is also the type check; `npm test` runs the `node:test` suites from `dist/`. The suites are offline: the CLI end-to-end tests (`packages/cli/test/e2e.test.ts`) run the real commands against an in-memory fake backend. Node 24 is the target; TypeScript is pinned to 6.0.3.

### Backend

`abfc.exe` bundles its backend. A source install needs `EmekC/abf-mod-editor-mcp` 2.4.0 or newer (tag `v2.4.0`; tag `v2.5.0` for `@director` rows). Point `ABFC_BACKEND_DIR` (or `--backend-dir`, or `backend.serverDir` in `abf.config.json`) at a checkout; abfc starts the server with `ABF_ABFC_TOOLS=1` for its opt-in tools. Install, settings, `abfc doctor`, capabilities and diagnostics are in [docs/backend.md](docs/backend.md).

A server older than 2.4.0 gets warning ABFC4014 (a protocol below 1 is error ABFC4001). Without `backend_info`, abfc prints warning ABFC4012 and wildcard pins use the two-phase fallback (apply, patch the rolled-back graph, apply it again as a raw block), which costs about 10-20 s more per build.

`abfc publish` builds and copies the built assets into the mod named in `abf.config.json` (about 30 s with a warm build; the Mod Editor may stay open with the mod loaded, stop Play In Editor first). Every publish backs up the replaced files first. `abfc publish --full` also runs the game tests, the stage audit and the upload file check: use it before an upload to mod.io. `--dry-run` lists what would be copied.

## Requirements

- Windows 10 or 11, 64-bit.
- Abiotic Factor Mod Editor, installed from the Epic Games Launcher.
- The backend: bundled in `abfc.exe`; a source install uses https://github.com/EmekC/abf-mod-editor-mcp (the only supported backend; abfc depends on no other repository).
- Node 24 or newer, only for a source install or to build abfc.

## Not affiliated

abfc is an independent community tool. It is not affiliated with, endorsed by or supported by Deep Field Games, Playstack or mod.io. Nothing derived from Deep Field content is committed to this repository.

## Credits

The backend, abf-mod-editor-mcp, was originally created by theelites11gamer (https://github.com/theelites11gamer/abf-mod-editor-mcp, MIT) and extended with the headless Blueprint tools by DezionDev. abfc depends only on EmekC/abf-mod-editor-mcp.

## License

MIT. See [LICENSE](LICENSE).
