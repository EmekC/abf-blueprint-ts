# abfc

abfc is a TypeScript-to-Blueprint compiler for Abiotic Factor mods. You write a mod's Blueprint logic as TypeScript classes, and abfc generates the Blueprint graphs in the mod through a headless Mod Editor backend. The `.ts` files are the source of truth, and the graphs are build artifacts.

Documentation: https://emekc.github.io/abf-blueprint-ts/

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

### Build and test

```
npm install
npm run build
npm test
```

`npm run build` is `tsc -b` and is also the type check; `npm test` runs the `node:test` suites from `dist/`. The suites are offline: the CLI end-to-end tests (`packages/cli/test/e2e.test.ts`) run the real commands against an in-memory fake backend. Node 24 is the target; TypeScript is pinned to 6.0.3.

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
