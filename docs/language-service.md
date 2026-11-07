# Language service and watch mode

`@abfc/ts-plugin` is a TypeScript language service plugin. Inside the editor it shows what `abfc check` would say about the
file you are typing in, a short description of the Blueprint nodes under the cursor, and two quick fixes. `abfc check --watch`
gives the same checks from a terminal task.

Parity is by construction: the plugin and `abfc check` both call the compiler's `checkProject()`. The plugin runs it over the
whole program (once per program version) and shows the part that belongs to the open file, so cross-file checks match.
`scripts/plugin-parity.mjs` compares the two on a project (see "Parity check").

## Setup

1. Add the plugin to the project's `tsconfig.json`:

   ```json
   {
     "compilerOptions": {
       "plugins": [{ "name": "@abfc/ts-plugin" }]
     }
   }
   ```

   The package has to be resolvable from the project (`npm install --save-dev @abfc/ts-plugin`).

2. Use the workspace TypeScript. The plugin runs the compiler's own `typescript` module on the nodes that tsserver
   creates, which is only safe for the same TypeScript version. When tsserver runs another version (VS Code's bundled one,
   for example) the plugin logs `[abfc] disabled: ...` once and does nothing. In VS Code: install `typescript@6.0.3` in
   the project, run **TypeScript: Select TypeScript Version** and pick **Use Workspace Version** (or set
   `typescript.tsdk` to `node_modules/typescript/lib`). TypeScript 7 (native) has no plugin API and cannot load the plugin.

3. Developing abfc itself (a checkout instead of an installed package): point tsserver at the built plugin with
   `typescript.tsserver.pluginPaths` in the workspace settings, for example
   `"typescript.tsserver.pluginPaths": ["<checkout>/packages/ts-plugin"]`, then run **TypeScript: Restart TS Server**.

The plugin also needs the project's `abf.config.json` (it looks for it from the tsconfig folder upwards) and the generated
stubs (`abfc stubs`). Without them it disables itself and logs the reason; TypeScript's own diagnostics are unaffected.

## What it shows

- **Subset diagnostics.** Everything `abfc check` reports with a position, as an extra diagnostic with `source: "abfc"`,
  the code `ABFCnnnn` in the message (`ABFC2010: ...`) and the numeric code. TypeScript's own errors stay tsserver's.
- **Hover.** Below the normal hover text a line `Blueprint: Cast To BP_Thing · Branch`: the Blueprint nodes the code under the
  cursor lowers to (at most six; `(+N more)` after that). It appears only when the project lowers without errors.
- **Quick fixes.**
  - `Use idiv(a, b) (Blueprint Divide_IntInt)` on ABFC2010 (integer `/` is not allowed): rewrites the division and adds
    `idiv` to the `@abfc/runtime` import.
  - `Use ?. (lowers to IsValid + Branch)` on TypeScript's "possibly null/undefined" errors (2531, 2532, 18047, 18048,
    18049) of a property or element access.

## What is not in parity

- `ABFC3001`-`ABFC3003` (stubs lock and editor fingerprint): they need the installed Mod Editor, which a language service
  does not look at.
- `ABFC2000` (a TypeScript error as seen by `abfc check`) is compared as the TypeScript diagnostic itself, not as an abfc
  diagnostic: the parity script matches the `[TS####]` code and position from the message against the language
  service's own TypeScript diagnostics (see `scripts/plugin-parity.mjs`).
- Diagnostics without a position, and TypeScript's global (non-file) diagnostics.
- ESLint. `abfc check` does not run ESLint; use `npx eslint` or the ESLint editor extension (see `docs/lint-rules.md`).
- VS Code may not offer the ABFC quick fix in the lightbulb if it asks for supported fixes without naming a file; the
  TypeScript-code fix (`?.`) is not affected.

## Parity check

```
npm run build
node scripts/plugin-parity.mjs --project <dir> [--project <dir> ...]
```

For each project the script runs `abfc check --json` and an in-process language service with the plugin, and compares per
file the abfc diagnostics and the TypeScript diagnostics by (code, file, line, column). It prints the counts and every
mismatch and exits 1 on any mismatch. A project without `abf.config.json` (the compiler test fixtures) is compared through a
temporary copy. The project itself is only read.

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
