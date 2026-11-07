# Install abfc

abfc compiles TypeScript classes into Blueprint graphs for Abiotic Factor mods and publishes them through the Mod Editor. This page covers installing it, updating it, removing it, and the source install for people who prefer Node. After installing, continue with [first-mod.md](first-mod.md).

Contents: [Requirements](#requirements), [Installer](#installer), [SmartScreen](#smartscreen), [Zip](#zip), [Verify a download](#verify-a-download), [First run](#first-run), [Update](#update), [Uninstall](#uninstall), [Source install](#source-install), [VS Code extension](#vs-code-extension), [Files abfc writes](#files-abfc-writes).

## Requirements

- Windows 10 or 11, 64-bit.
- The Abiotic Factor Mod Editor, installed from the Epic Games Launcher, with at least one mod created in it. abfc never creates a mod; you do that in the Mod Editor (see [first-mod.md](first-mod.md)).
- Nothing else for the installer or the zip: `abfc.exe` carries its own Node runtime, its own Python and the Mod Editor backend. Node, Python and a backend checkout are needed only for the [source install](#source-install).

## Installer

1. Open the releases page of the project, https://github.com/EmekC/abf-blueprint-ts/releases, and download `abfc-setup-<version>.exe` from the newest release that is not marked as a pre-release.
2. Run it. Windows will probably warn about an unknown publisher; see [SmartScreen](#smartscreen).
3. The installer works per user and asks for no administrator rights. It installs into `%LOCALAPPDATA%\Programs\abfc\`: `abfc.exe`, the VS Code extension file `abfc-vscode-<version>.vsix`, `LICENSE.txt`, `THIRD-PARTY-NOTICES.txt` and `README.txt`.
4. Two optional tasks are offered on the tasks page:
   - **Add abfc to the PATH** (on by default): adds the install folder to your user `PATH`, so `abfc` works in any terminal.
   - **Install the VS Code extension**: shown only when the installer finds VS Code (`code.cmd`). It runs `code --install-extension` for the bundled `.vsix`.
5. Open a new terminal (an already open one does not see the new `PATH`) and run:

```
abfc --version
```

It prints a line such as `abfc 1.0.0 (exe, node 26.7.0)`. If the command is not found, see [troubleshooting.md](troubleshooting.md#abfc-is-not-found-after-installing).

For unattended installs the installer accepts the usual Inno Setup switches, for example `abfc-setup-<version>.exe /VERYSILENT /MERGETASKS="!addtopath,!vsix"` to install without the two optional tasks.

## SmartScreen

abfc is not code-signed, so a downloaded installer or `abfc.exe` is "unknown" to Windows and SmartScreen shows **Windows protected your PC**. This is expected. To continue:

1. Click **More info** in the dialog.
2. Click **Run anyway**.

If you want to be sure the file is the one the project published, [verify the download](#verify-a-download) before running it. Some browsers also hold unsigned `.exe` downloads back; choose to keep the file in the browser's download list. The zip avoids the installer prompt, but Windows may still show the same check the first time `abfc.exe` runs.

## Zip

`abfc-<version>-win-x64.zip` from the same releases page holds the same files without an installer: `abfc.exe`, `README.txt`, `LICENSE.txt`, `THIRD-PARTY-NOTICES.txt` and `abfc-vscode-<version>.vsix`.

1. Right-click the zip, choose **Properties**, tick **Unblock** if it is offered, then extract it to a folder you keep, for example `%LOCALAPPDATA%\Programs\abfc`.
2. Either add that folder to your `PATH` (Settings, System, About, Advanced system settings, Environment Variables, the `Path` of your user) or run `abfc.exe` by its full path.
3. For VS Code, install the extension file once:

```
code --install-extension abfc-vscode-<version>.vsix
```

   Use the exact file name from the folder.

## Verify a download

Every release has a `SHA256SUMS.txt` with one line per file: the SHA-256 hash and the file name. Compare it with the hash of your download:

```
Get-FileHash .\abfc-setup-<version>.exe -Algorithm SHA256
```

The `Hash` column must equal the line for that file in `SHA256SUMS.txt`. Case does not matter. If it differs, delete the file and download it again.

## First run

The first command that needs the bundled backend or Python unpacks them once into `%LOCALAPPDATA%\abfc\runtime\<version>-<id>\`. Every file is checked against a manifest while it is unpacked, and a quick check runs on later starts. `abfc doctor` prints the folder, and `abfc doctor --deep` re-checks every file by hash.

Set `ABFC_RUNTIME_DIR` to unpack somewhere else, for example when the default drive is full. See [config.md](config.md) for all settings and [troubleshooting.md](troubleshooting.md#damaged-or-stale-runtime-folder) if the unpacking fails.

## Update

There is no updater and abfc never touches the network to update itself.

- **Installer:** download the newer `abfc-setup-<version>.exe` and run it. It upgrades the existing installation in place.
- **Zip:** extract the new zip over a fresh folder, or replace the files of the old folder.
- **Source install:** see [Source install](#source-install).

Older extracted runtime folders stay behind after an update. Delete them with:

```
abfc doctor --clean-runtimes
```

It works outside a project, keeps the folder of the running `abfc.exe`, and removes only folders that abfc itself created.

## Uninstall

- **Installer:** Windows Settings, Apps, abfc, Uninstall. It removes the program folder and the `PATH` entry, and asks before deleting the extracted runtime (`%LOCALAPPDATA%\abfc\runtime`). A silent uninstall keeps the runtime; delete the folder yourself if you want it gone.
- **Zip:** delete the folder, remove it from your `PATH` if you added it, and delete `%LOCALAPPDATA%\abfc\runtime`.

Your projects, your mods and the user config (`%APPDATA%\abfc\config.json`) are never touched. The VS Code extension is removed in VS Code (Extensions view, abfc, Uninstall).

## Source install

For people who want to run abfc from Node instead of `abfc.exe`.

**What you need**

- Node 24 or newer.
- Python 3.9 or newer on `PATH` (not the Microsoft Store alias; `py -3` and `python` are both tried), or the path given with `--python` or `ABFC_PYTHON`.
- A checkout of the backend, https://github.com/EmekC/abf-mod-editor-mcp. The minimum version is 2.4.0. Class-manager rows (`@director`) need 2.5.0. The `abfc doctor` command prints the version it found and warns when it is too old.

**abfc itself**, either from npm once the packages are published:

```
npm install -g @abfc/cli
```

or from a git checkout:

```
git clone https://github.com/EmekC/abf-blueprint-ts
cd abf-blueprint-ts
npm ci
npm run build
```

The checkout is run as `node packages/cli/dist/src/bin.js <command>`. Put a small `abfc.cmd` next to it or an alias on that line if you want the short name.

**The backend**

```
git clone https://github.com/EmekC/abf-mod-editor-mcp <backend dir>
git -C <backend dir> checkout <tag>
```

Use the newest release tag, at least `v2.4.0` (`v2.5.0` for `@director` rows). Tell abfc where it is once; the path goes into your user config:

```
abfc init --backend-dir <backend dir>
```

or set the environment variable `ABFC_BACKEND_DIR`. A project can also carry `backend.serverDir` in `abf.config.json`, but that is a machine path, so prefer the user config. The backend's details (capabilities, what abfc sets when it starts the server, diagnostics) are in [backend.md](backend.md).

To update a source install, pull or reinstall abfc and check out a newer backend tag. abfc never modifies the backend checkout.

## VS Code extension

The extension is a `.vsix` file, not a marketplace extension. The installer installs it for you when you tick the task. By hand, run `code --install-extension abfc-vscode-<version>.vsix` with the file from the install folder or the zip.

The extension starts when a workspace contains an `abf.config.json`. It finds abfc in this order and uses the first hit:

1. the setting `abfc.path` (an executable, or a `.js` file that is started with `node`);
2. `abfc.exe` in a `PATH` folder;
3. an npm global install (`abfc.cmd` on `PATH` with the CLI package beside it);
4. the installer folder, `%LOCALAPPDATA%\Programs\abfc\abfc.exe`;
5. for a source install, `node_modules\@abfc\cli\dist\src\bin.js` in a workspace folder, then the setting `abfc.cliPath`.

If nothing is found, the extension shows one message with a link to this page. Fix the `PATH` or the setting and run **abfc: Restart Language Server** from the command palette. In a workspace you have not trusted, the workspace-controlled steps (`abfc.path`, the workspace `bin.js`, `abfc.cliPath`) are skipped. More, including other editors, is in [language-service.md](language-service.md).

## Files abfc writes

| File | What | Committed |
| --- | --- | --- |
| `%APPDATA%\abfc\config.json` (or the file named by `ABFC_USER_CONFIG`) | Per-machine settings written by `abfc init`: the Mod Editor folder, the mods folder, and for a source install the backend folder and Python. | no |
| `%LOCALAPPDATA%\abfc\runtime\` (or `ABFC_RUNTIME_DIR`) | The unpacked backend and Python of `abfc.exe`. | no |
| `abf.config.json`, `tsconfig.json`, `src\`, `.vscode\` | Project files, written by `abfc init` into the project folder only. | yes |
| `.abfc\` in the project | Generated stubs, caches and reports (ignored by git; `abfc init` adds them to `.gitignore`), and `.abfc\manifest\` with the record of what abfc built. | the manifests yes, the rest no |
| `<mods folder>\<mod>\...` | The built assets, written by `abfc publish` only, and only into the mod named in `abf.config.json`. | n/a |

`abfc init` never writes into the mods folder or a mod folder. See [config.md](config.md) for every setting.
