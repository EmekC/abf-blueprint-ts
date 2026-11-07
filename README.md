# abfc

abfc is a TypeScript-to-Blueprint compiler for Abiotic Factor mods. You write a mod's Blueprint logic as TypeScript classes, and abfc generates the Blueprint graphs in the mod through a headless Mod Editor backend. The `.ts` files are the source of truth, and the graphs are build artifacts.

Repository: https://github.com/EmekC/abf-blueprint-ts

## Status

Phases 0 to 2 are done: abfc builds, tests and gates the full Blueprint logic (actors and components) of a real mod from TypeScript. Phase 3 (widgets) is implemented, with the manual in-game HUD check still pending; see the roadmap.

- [docs/design.md](docs/design.md): goals, workflow, compiler architecture, backend interface, safety rules and open questions.
- [docs/roadmap.md](docs/roadmap.md): the phased plan.

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
| `@abfc/cli` | the `abfc` command: `doctor`, `stubs`, `check`, `build`, `test`, `status`, `adopt`, `publish` |

### Build and test

```
npm install
npm run build
npm test
```

`npm run build` is `tsc -b` and is also the type check; `npm test` runs the `node:test` suites from `dist/`. The suites are offline: the CLI end-to-end tests (`packages/cli/test/e2e.test.ts`) run the real commands against an in-memory fake backend. Node 24 is the target; TypeScript is pinned to 6.0.3.

### Backend

`ABFC_BACKEND_DIR` must point at a checkout of `EmekC/abf-mod-editor-mcp` that has the abfc tools. Until they are merged, that is the `abfc-p1-backend` branch; abfc starts the server with `ABF_ABFC_TOOLS=1`, which switches on the opt-in `abfc_extensions` and `reflect` tools.

Wildcard pins (array length, array item, casts) use one apply when the backend's `backend_info` reports `pin_types` (branch `abfc-wildcard-pins`). Without `backend_info`, abfc prints warning ABFC4012 and uses the two-phase fallback (apply, patch the rolled-back graph, apply it again as a raw block), which costs about 10-20 s more per build.

`abfc publish` builds and copies the built assets into the mod named in `abf.config.json` (about 30 s with a warm build; the Mod Editor may stay open with the mod loaded, stop Play In Editor first). Every publish backs up the replaced files first. `abfc publish --full` also runs the game tests, the stage audit and the upload file check: use it before an upload to mod.io. `--dry-run` lists what would be copied.

## Requirements

- Windows.
- Abiotic Factor Mod Editor, installed from the Epic Games Launcher.
- The backend: https://github.com/EmekC/abf-mod-editor-mcp (the only supported backend; abfc depends on no other repository).
- Node 24 LTS.

## Not affiliated

abfc is an independent community tool. It is not affiliated with, endorsed by or supported by Deep Field Games, Playstack or mod.io. Nothing derived from Deep Field content is committed to this repository.

## Credits

The backend, abf-mod-editor-mcp, was originally created by theelites11gamer (https://github.com/theelites11gamer/abf-mod-editor-mcp, MIT) and extended with the headless Blueprint tools by DezionDev. abfc depends only on EmekC/abf-mod-editor-mcp.

## License

MIT. See [LICENSE](LICENSE).
