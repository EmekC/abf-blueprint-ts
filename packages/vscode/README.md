# abfc for VS Code

Editor support for Abiotic Factor mods written in TypeScript with [abfc](https://github.com/EmekC/abf-blueprint-ts).
The extension starts `abfc lsp`, the abfc language server, for TypeScript files inside a folder that holds an
`abf.config.json`.

- Diagnostics: the same findings as `abfc check`, lock problems on `abf.config.json`, and the abfc lint rules.
- Hover: the Blueprint nodes a statement lowers to, and the description of a stub member.
- Quick fixes: `idiv`, `?.`, redundant or relative `path:`, `@mod/` imports, `@director`, keep the existing asset path.
- Validation and completion for `abf.config.json` from a bundled JSON schema.
- Tasks that run `abfc build`, `abfc test`, `abfc publish --dry-run` and `abfc doctor` with the `$abfc` problem matcher.

This extension is not on the marketplace. It is installed from a `.vsix` file.

## Install

```
code --install-extension abfc-vscode-<version>.vsix
```

The extension needs abfc itself. It looks for it in this order: the `abfc.path` setting, `abfc.exe` on `PATH`, an npm
global install, the installer's default folder, `node_modules/@abfc/cli` in a workspace folder, and the `abfc.cliPath`
setting. When none is found it shows one message with a link to the install docs.

## Settings

| Setting | Meaning |
| --- | --- |
| `abfc.path` | Path to `abfc.exe`, or to a `.js` entry that is started with `node`. |
| `abfc.cliPath` | Source install: path to `packages/cli/dist/src/bin.js`. |
| `abfc.trace.server` | `off`, `messages` or `verbose`: traces the language server protocol. |

Changing `abfc.path` or `abfc.cliPath` restarts the language server.

## Commands

`abfc: Build`, `abfc: Test`, `abfc: Publish (dry run)`, `abfc: Doctor` (each runs the command as a task in the project
folder) and `abfc: Restart Language Server`.

More: [docs/language-service.md](https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/language-service.md).
