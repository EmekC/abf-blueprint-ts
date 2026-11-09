# abfc - instructions for Claude

abfc compiles TypeScript classes into Abiotic Factor Blueprints. This file tells you how to build, test and, above all, how to keep the documentation site (the wiki) current.

## Build and test

- Node 24. `npm install`, then `npm run build` (`tsc -b` over all packages), then `npm test`.
- There is no linter. (ESLint appears only as the shipped plugin in `packages/eslint-plugin`.)
- Never push, tag, release or deploy by hand. Release steps are in `docs/releasing.md` and are the maintainer's job.

## Documentation site (the wiki)

- The site is https://emekc.github.io/abf-blueprint-ts/ . It is a Starlight (Astro) project in `website/`, outside the npm workspace (own `package.json` and `package-lock.json`).
- CI builds and deploys it: `.github/workflows/docs.yml` builds on pull requests that touch the doc inputs and deploys to GitHub Pages on every push to `main` that touches them. Never deploy by hand; merging the change to `main` is the deploy.
- Doc inputs (a change to any of these triggers the workflow): `docs/**`, `website/**`, `CHANGELOG.md`, `README.md`, `packages/stubgen/data/descriptions.json`.
- Keep the docs current in the same change as the code. A change is docs-relevant when a user, a mod author or an editor user could notice it.

### What to edit for which change

- New or changed CLI command or option: `docs/cli.md`.
- New or changed error code: `docs/errors.md`. Use a `### ABFCnnnn` heading with Severity / Meaning / Fix lines (a test enforces the shape). Editor diagnostics link to these anchors.
- New or changed lint rule: `docs/lint-rules.md` (one `##` heading per rule, named exactly like the rule; ESLint and the editor link to it).
- Config keys or environment variables: `docs/config.md`.
- Runtime API (`packages/runtime/src/index.ts`): `docs/runtime.md`. One `### \`name\`` section per API: one plain-English sentence saying which Blueprint node or feature it mimics, then a short ```ts snippet. The site search indexes these headings.
- A change to the minimum setup path (install, `abfc init`, first build, publish): `docs/getting-started.md`, and `docs/install.md` / `docs/first-mod.md` where they say the same thing.
- Editor features (hover, completion, diagnostics, VS Code commands): `docs/language-service.md`.
- Known limits and workarounds: `docs/known-issues.md`; fixes for common problems: `docs/troubleshooting.md`.
- Any user-visible change: a line under Unreleased in `CHANGELOG.md`, plus the matching page above.
- Language and compiler design (syntax lowering, decorators, pipeline): `docs/design.md`; planned work: `docs/roadmap.md`.

### Node reference (one page per engine and game function)

- Every Blueprint-callable function of every `/Script` module in `website/data/node-signatures.json` has a generated page, about 3,300 of them in 12 modules. Pages come from the Astro routes `website/src/pages/reference/nodes/[slug].astro` and `website/src/pages/reference/modules/[module].astro`, fed by `npm run generate`. Do not write node pages by hand.
- Rule: the wiki and `website/data` may contain all information, including game-module names and node names. `packages/*/data` and `packages/*/test` may not (they ship in runtime.zip and npm packages; `packages/ir/test/no-deep-field-names.test.ts` guards them), so `descriptions.json` stays engine-only. Reflected tooltip text is not copied to the site.
- Refresh the index after an engine or game update, or a stub generator change: run `abfc generate` in a project (abfc 0.7.0 or later; the script refuses older stubs), then
  `node scripts/docs-node-signatures.mjs --stubs <project>/.abfc/stubs/<profile>`
  and commit the updated `website/data/node-signatures.json`. Use the project with the most `Script/*.d.ts` modules. CI cannot do this step because the stubs are generated from game files and are never committed.
- Curated entries add a one-liner and a hand-written snippet that replaces the generated one. To add or change one, edit its entry in `packages/stubgen/data/descriptions.json`:
  - `text`: one clear sentence in your own words, no trailing period, no copied engine tooltip, no game names (a test guards `packages/*/data`).
  - `displayName` (optional): only when the Blueprint node name differs from the rule in `packages/ir/src/displayname.ts`.
  - `snippet`: array of lines, 1 to 6: the `import` first, a blank line, then the minimal call. Latent calls (like `Delay`) are plain calls inside an `@event`.
- `@bpUnsupported delegate` on a stub function does NOT mean the node is unusable. Delegate pins take `this.<EventName>`, a reference to an `@event` method of the same class (anything else is ABFC2054), for example `KismetSystemLibrary.K2_SetTimerDelegate(this.OnTick, 1.0, true)`. Document it that way; the generated page already does. Other `@bpUnsupported` labels (`name:Set`, `class:Map`, `fieldpath`, `bad_type`, `mcdelegate`) are pins abfc cannot pass yet.

### Adding a page, and rules that protect links

- New docs page: add the file to `DOC_PAGES` in `website/lib/docs-sync.mjs`, to the `sidebar` in `website/astro.config.mjs`, and to the `DOCS` list in `scripts/release/test/docs.test.mjs` (link and anchor checks).
- The node reference sidebar comes from the module list in `website/astro.config.mjs`; do not list functions there.
- Edit `docs/*.md`, never `website/src/content/docs/`: that folder is generated (gitignored) except the hand-written `index.mdx`. `website/public/search-index.json` is generated too.
- Link between docs files with relative links (`errors.md#abfc2054`) so GitHub and the site both work. Link to the node reference with the absolute site URL.
- Do not rename a page slug, a node slug rule, or a heading that is an anchor target (`#abfcnnnn`, lint rule names). Released LSP, ESLint and VS Code builds link to them (`packages/lsp/src/docs.ts`, `packages/eslint-plugin/src/util.ts`, `packages/vscode/src/extension.ts`).
- No feedback ("was this helpful") widget or text anywhere on the site or in llms.txt.

### Check it locally

1. `npm run build && npm test` at the repo root. This includes `website/test/*.test.mjs` and `scripts/release/test/docs.test.mjs`; the parity test needs the root build first.
2. `cd website && npm ci && npm run build` (about 1 minute for the ~3,400 pages; it runs the generator first and fails on broken doc links). Use `npm run preview` to click through; search (Ctrl+K) works only in the built site.
3. Do not commit `website/dist/`, `website/node_modules/` or generated content.
