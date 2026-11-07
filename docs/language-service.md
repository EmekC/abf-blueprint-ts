# Language service and watch mode

`abfc lsp` is a language server (LSP 3.17, over stdio). In an editor it shows what `abfc check` would say about the file you
are typing in, the lint findings of `@abfc/eslint-plugin`, a short description of the Blueprint nodes under the cursor, and
quick fixes. `abfc check --watch` gives the same checks from a terminal task.

Parity is by construction: the server and `abfc check` both call the compiler's `checkProject()`. The server runs it over
the whole program (once per program version, over the editor's unsaved text) and shows the part that belongs to each open
file, so cross-file checks match. `scripts/lsp-parity.mjs` compares the two on a project (see "Parity check").

The server uses the compiler's own TypeScript, so it needs no `typescript.tsdk` setting and no matching workspace
TypeScript. It never starts Python or the backend, and it never writes into a project.

## VS Code

The extension is a `.vsix` (it is not on the marketplace). Install the file from the release, or build it from a checkout
and install it:

```
npm install
npm run vsix
code --install-extension build/vsix/abfc-vscode-<version>.vsix
```

The extension starts when a workspace contains an `abf.config.json`. It runs `abfc lsp` for TypeScript files; one server
serves every project of the workspace, and files outside a project are ignored.

How the extension finds abfc (the first hit wins):

1. the setting `abfc.path`: an executable, or a `.js` file that is started with `node`;
2. `abfc.exe` (`abfc` outside Windows) in a `PATH` folder;
3. an npm global install: `abfc.cmd` in a `PATH` folder with `node_modules/@abfc/cli/dist/src/bin.js` beside it (started
   with `node`);
4. the installer default, `%LOCALAPPDATA%\Programs\abfc\abfc.exe` (Windows);
5. a source install: `node_modules/@abfc/cli/dist/src/bin.js` in a workspace folder, then the setting `abfc.cliPath` (the
   `packages/cli/dist/src/bin.js` of a checkout).

If nothing is found, the extension shows one message and does not retry; fix the setting or `PATH` and run
**abfc: Restart Language Server**.

Settings: `abfc.path`, `abfc.cliPath` (changing either restarts the server) and `abfc.trace.server` (`off`, `messages`,
`verbose`).

Commands (each runs the CLI as a VS Code task in the project folder, with the `$abfc` problem matcher):
**abfc: Build**, **abfc: Test**, **abfc: Publish (dry run)**, **abfc: Doctor**, and **abfc: Restart Language Server**.

The extension also validates `abf.config.json` against a JSON schema (completion and hover for its keys). The schema's
source is `packages/cli/schema/abf.config.schema.json`.

## Other editors

Any LSP client can run `abfc lsp` (`abfc lsp --stdio` is the same; a `--clientProcessId=<n>` argument is accepted and
ignored). The project is found per document by walking up to `abf.config.json`.

Neovim:

```lua
vim.lsp.start({
  name = "abfc",
  cmd = { "abfc", "lsp" },
  root_dir = vim.fs.root(0, "abf.config.json"),
})
```

Helix, `languages.toml` (keep the TypeScript server next to it; abfc adds to it and does not replace it):

```toml
[language-server.abfc]
command = "abfc"
args = ["lsp"]

[[language]]
name = "typescript"
language-servers = ["typescript-language-server", "abfc"]
```

Zed and JetBrains: add a generic LSP client (a "custom language server" entry in Zed, an LSP4IJ or similar plugin in
JetBrains) with the command `abfc lsp` for TypeScript files. Outside VS Code there is usually no per-editor extension to
pass the options below; set them in the client's initialization options.

## Initialization options

Sent in `initialize` as `initializationOptions`:

| Option | Default | Effect |
| --- | --- | --- |
| `tsDiagnostics` | `false` | Also publish TypeScript's own errors as `ABFC2000` (`[TS2339] ...`). Leave it off when the editor has a TypeScript server, which already shows them. |
| `tsHover` | `false` | Add the symbol and its type (`name: type`) to the hover. Leave it off when the editor has a TypeScript server. |
| `lint` | `true` | Run the recommended `@abfc/eslint-plugin` rules in the server. |

The VS Code extension sends `tsDiagnostics: false` and `tsHover: false`.

## What it shows

- **Diagnostics.** Everything `abfc check` reports for the open file, with `source: "abfc"`, the code `ABFCnnnn`, a link
  to the error code reference, and the suggested fix text appended to the message. The text is the editor's unsaved
  content. Updates arrive 300 ms after the last change.
- **Config-level codes.** The stubs lock codes `ABFC3001`-`ABFC3003`, and a config that does not load, are shown on
  `abf.config.json` at its first line (they have no position in a TypeScript file). The server reloads the config and the
  stubs state when `abf.config.json`, a manifest, a stubs lock or `retired.json` changes on disk.
- **Lint findings.** The recommended rules of `@abfc/eslint-plugin` ([lint-rules.md](lint-rules.md)), run in the
  server with the server's own TypeScript program. They have source `abfc`, the rule id as code
  (`abfc/no-loop-in-tick`) and warning severity. No ESLint config is needed or read.
- **Hover.** The first line of a stub member's description, and a line `Blueprint: Cast To BP_Thing · Branch`: the
  Blueprint nodes the code under the cursor lowers to (at most six; `(+N more)` after that). The node line appears only
  when the project lowers without errors.
- **Quick fixes** (kind `quickfix`):
  - `Use idiv(a, b) (Blueprint Divide_IntInt)` on ABFC2010 (integer `/` is not allowed): rewrites the division and adds
    `idiv` to the `@abfc/runtime` import.
  - `Use ?. (lowers to IsValid + Branch)` on TypeScript's "possibly null/undefined" errors (2531, 2532, 18047, 18048,
    18049) of a property or element access. It works even with `tsDiagnostics` off, because the server holds those errors.
  - `Remove the redundant path:` on ABFC2006.
  - `Write path: relative to the mod` on ABFC2005.
  - `Import from @mod/` on ABFC2008.
  - `Replace classManagerRow with @director` on ABFC2076.
  - `Keep the existing asset path (path: "...")` on ABFC5012 (a moved or renamed source file).

Completion, go to definition and rename are not provided; they stay with the editor's TypeScript server.

## Moving from @abfc/ts-plugin

The tsserver plugin `@abfc/ts-plugin` is retired and its package is gone. It only worked with the workspace TypeScript
(6.0.3 from `node_modules`) and only in editors that load tsserver plugins.

1. Remove the `{ "name": "@abfc/ts-plugin" }` entry from `compilerOptions.plugins` in `tsconfig.json`
   (`abfc init` prints warning `ABFC1043` with this change when it finds the entry), and uninstall the package.
2. Remove a `typescript.tsdk` or `typescript.tsserver.pluginPaths` setting that was only there for the plugin.
3. Install the VS Code extension or configure your editor as above.

## Parity check

```
npm run build
node scripts/lsp-parity.mjs --project <dir> [--project <dir> ...]
```

For each project the script computes the reference in-process (the compiler's `checkProject()` over the project, with the
same environment helper the server uses), starts `abfc lsp --stdio` with `tsDiagnostics` on, opens every project file
over the protocol and compares the diagnostics by (code, file, line, column): the abfc diagnostics and the TypeScript
diagnostics (matched by the `[TS####]` code in the message). Lint findings are counted and printed, not compared. It
prints the counts and every mismatch, and exits 1 on any mismatch. A project without `abf.config.json` (the compiler test
fixtures) is compared through a temporary copy. The project itself is only read.

## What is not in parity

- Diagnostics without a position, and TypeScript's global (non-file) diagnostics: `abfc check` prints them, but a
  language server can only show them on a file.
- The stubs lock codes `ABFC3001`-`ABFC3003` go on `abf.config.json` in the editor, and `abfc check` stops on them
  instead of continuing; the parity script compares file diagnostics only.
- `tsHover` shows the symbol and its type, not the full quick info of tsserver.
- `abfc check` does not run ESLint; the server does (the lint findings above). Use `npx eslint` in CI (see
  [lint-rules.md](lint-rules.md)).

## Watch mode

`abfc check --watch` checks once, then again after every relevant change, and stays running until Ctrl+C. It cannot be
combined with `--json`. Each run prints:

```
[abfc] check started
<diagnostics, in the problem-matcher form>
checked N unit(s) in M asset(s), K test(s): no errors
[abfc] check finished: <e> error(s), <w> warning(s) in <s.ss> s
```

Relevant changes: `*.ts` files (not under `node_modules/` or `.abfc/`, except `.abfc/stubs/`), `tsconfig*.json`,
`abf.config.json`, `.abfc/tsconfig.paths.json`, `.abfc/manifest/**` and `.abfc/stubs/*/stubs.lock.json`. Changes are
debounced by 150 ms; a change during a run triggers one more run after it. Runs reuse the previous TypeScript program, so
a run after a one-file edit takes well under a second on a project of this size.

### VS Code task

`.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "abfc check --watch",
      "type": "shell",
      "command": "abfc check --watch",
      "isBackground": true,
      "problemMatcher": {
        "owner": "abfc",
        "fileLocation": ["relative", "${workspaceFolder}"],
        "pattern": {
          "regexp": "^(.*\\.ts):(\\d+):(\\d+): (error|warning) (ABFC\\d+): (.*)$",
          "file": 1,
          "line": 2,
          "column": 3,
          "severity": 4,
          "code": 5,
          "message": 6
        },
        "background": {
          "activeOnStart": true,
          "beginsPattern": "^\\[abfc\\] check started",
          "endsPattern": "^\\[abfc\\] check finished"
        }
      },
      "group": "build"
    }
  ]
}
```
