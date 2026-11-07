# @abfc/cli

abfc compiles mods written in TypeScript to Blueprint graphs for Abiotic Factor, tests them without the game and
publishes them into a mod through the official Mod Editor.

```
npm install -g @abfc/cli
abfc --version
```

Requires Node.js 24 or newer and Windows with the Abiotic Factor Mod Editor installed.

An npm install does not contain the backend that talks to the Mod Editor. Point abfc at a checkout of the backend
(`abfc init --backend-dir <dir>` or the `ABFC_BACKEND_DIR` environment variable), or use the Windows installer or zip
from the release page, which bundle the backend and its Python runtime.

- Installation and the backend: [docs/install.md](https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/install.md)
- Your first mod: [docs/first-mod.md](https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/first-mod.md)

abfc is not affiliated with or endorsed by the makers of Abiotic Factor. MIT license.
