# Troubleshooting

Known limitations and their workarounds (stale entries in the open Mod Editor, a staged file in use, struct changes) are in [known-issues.md](known-issues.md).

Start with `abfc doctor`. It prints every setting with the place it came from (flag, environment variable, project config, user config or auto-discovery), the versions it found, and the problems it can see. Each problem has an `ABFCnnnn` code; the meaning of every code is in [errors.md](errors.md). All paths below use placeholders such as `C:\Users\<you>`; replace them with your own.

Sections: [OneDrive Documents](#onedrive-redirected-documents), [user names with spaces](#user-names-with-spaces-and-the-headless-folder), [non-English Windows](#non-english-windows), [long paths](#long-paths), [SmartScreen](#smartscreen), [antivirus](#antivirus-quarantine-or-locked-files), [runtime folder](#damaged-or-stale-runtime-folder), [bundled backend overridden](#abfc1053-the-exe-uses-a-backend-outside-its-runtime), [first stubs](#the-first-abfc-generate-needs-the-network), [abfc not found](#abfc-is-not-found-after-installing), [extension](#the-vs-code-extension-cannot-find-abfc), [publish refused](#publish-is-refused), [two builds](#a-second-build-is-refused-abfc4019), [staged file in use](#a-staged-file-is-still-in-use), [deleted assets still listed](#the-editor-still-lists-a-deleted-asset), [edits in the editor disappear](#my-edits-in-the-mod-editor-disappeared), [superseded struct](#a-struct-stays-after-a-rename-abfc5018), [Epic login](#the-epic-login-window-of-the-stage-audit). Fixed problems and limitations of this version are collected in [known-issues.md](known-issues.md).

## OneDrive-redirected Documents

The Mod Editor keeps mods in `<Documents>\Abiotic Factor Mods`. When Windows redirects Documents to OneDrive or to another drive, that is not `C:\Users\<you>\Documents`. abfc does not guess the path from `%USERPROFILE%`: it asks Windows for the real Documents folder (the Known Folder), through the backend, and falls back to the registry value `Personal` under the User Shell Folders key when no backend runs. That normally gives the right folder.

If `abfc doctor` still shows the wrong mods folder, or [ABFC1003](errors.md#abfc1003) says the folder does not exist, name it yourself, in order of precedence:

- the flag `--mods-dir <folder>` for one command;
- the environment variable `ABFC_MODS_DIR`;
- `modsDir` in the user config (`abfc init --mods-dir <folder>` writes it there).
## User names with spaces and the headless folder

The backend starts the Mod Editor without a window through a "headless folder", by default `%LOCALAPPDATA%\abf-mod-editor-mcp\headless`. The editor launch cannot handle a space in that path. A Windows user name with a space (for example `Jane Doe`) puts a space into `%LOCALAPPDATA%`, and abfc stops with [ABFC1012](errors.md#abfc1012) before launching anything.

Pick a folder without spaces and tell abfc once:

- the environment variable `ABF_HEADLESS_DIR`, set in your user environment variables to a folder such as `C:\abfc-headless`;
- or the flag `--headless-dir C:\abfc-headless` on a command;
- or `headlessDir` in the user config.

A user name with non-ASCII letters only produces the warning [ABFC1013](errors.md#abfc1013): it is unverified whether the editor launch copes with them. If the launch fails, use the same remedy with an ASCII-only folder.

## Non-English Windows

Localized Windows has localized folder names ("Dokumente", "Documentos") and a different display name for Documents. abfc uses the Known Folder lookup described above, never the English folder name, and finds the Mod Editor through the Epic launcher's manifest files, so a localized system normally works without settings. When the Mod Editor was installed to a custom location or the manifests are missing, pass `--editor-root <folder>` or set `ABFC_EDITOR_ROOT` (or write it with `abfc init --editor-root <folder>`). The folder with the mods is overridden the same way as in [OneDrive Documents](#onedrive-redirected-documents).

## Long paths

Unreal refuses asset paths that grow too long, and Windows still has a 260-character limit in many tools. abfc therefore limits the whole package path of an asset (`/<mod>/<folders>/<class>`) to 160 characters, each folder name and the class name to 64 characters, and allows only ASCII letters, digits and `_` in them. A violation is [ABFC2002](errors.md#abfc2002) and names the offending folder or class.

Keep the project folder and the mod path short as well, for example `C:\abfc\ExampleMod` rather than a deep folder inside Documents. A shorter folder and class name, or an explicit `path:` option, resolves the error.

## SmartScreen

abfc is not code-signed, so Windows shows "Windows protected your PC" for the installer and, the first time, for `abfc.exe`. Choose **More info**, then **Run anyway**. Compare the file's hash with `SHA256SUMS.txt` first if you want to be sure. The steps are in [install.md](install.md#smartscreen).

## Antivirus quarantine or locked files

Antivirus software may remove a freshly downloaded `abfc.exe`, or scan the files abfc unpacks into `%LOCALAPPDATA%\abfc\runtime` at the moment abfc wants to rename or start them. Symptoms are a missing exe, "access denied" while unpacking, or a runtime that cannot be replaced.

- [ABFC1050](errors.md#abfc1050): the runtime could not be unpacked or moved into place. Check free disk space and the antivirus quarantine, close other abfc processes, and run `abfc doctor --deep`. Setting `ABFC_RUNTIME_DIR` to another folder is a workaround.
- [ABFC1051](errors.md#abfc1051): a damaged runtime folder is in use and cannot be replaced, or a folder could not be removed because something has it open. Close other abfc processes (the language server in VS Code counts), then run the command again.
- Add an exclusion for the abfc install folder and for `%LOCALAPPDATA%\abfc` if your antivirus allows it, or restore the quarantined file. The zip is useful here: you can extract it to a folder you have already excluded.

## Damaged or stale runtime folder

`abfc.exe` unpacks its backend and Python once into `%LOCALAPPDATA%\abfc\runtime\<version>-<id>\`.

- `abfc doctor --deep` checks every file of that folder by SHA-256. A mismatch moves the folder aside and unpacks it again on the next run.
- `abfc doctor --clean-runtimes` deletes the runtime folders of other abfc versions (it works outside a project and keeps the folder of the running exe). It removes only what abfc created.
- [ABFC1052](errors.md#abfc1052): the archive inside `abfc.exe` itself does not match its manifest. The exe is damaged; download it again, verify it against `SHA256SUMS.txt`, and reinstall.

## ABFC1053: the exe uses a backend outside its runtime

[ABFC1053](errors.md#abfc1053) is a warning. `abfc.exe` carries its own backend and Python, but an older source-install setting still wins by the normal precedence: `ABFC_BACKEND_DIR`, `ABFC_PYTHON`, `--backend-dir`, `--python`, or `backend.serverDir` and `backend.python` in a config file. Remove those settings to use the bundled ones, or keep them on purpose and ignore the warning.

## The first `abfc generate` needs the network

`abfc generate` reads the installed Mod Editor through the backend. The backend also keeps a list of Blueprint functions that the upload check allows, and it downloads that list the first time it needs it. The first run on a machine therefore needs internet access once. If a firewall blocks it, the command fails with a backend error; allow the access or run it once on another connection. The file is stored inside the backend folder and is reused afterwards. Nothing derived from the game is part of abfc's own files or releases.

## abfc is not found after installing

A terminal that was already open does not see a new `PATH` entry. Open a new terminal (in VS Code, close the integrated terminal and open a new one, or restart VS Code). If it still fails, check:

- the installer's "Add abfc to the PATH" task was ticked (run the installer again and tick it), or the folder holding `abfc.exe` is on your user `PATH`;
- `where abfc` shows `%LOCALAPPDATA%\Programs\abfc\abfc.exe`;
- or call it by its full path, `& "$env:LOCALAPPDATA\Programs\abfc\abfc.exe" --version`.

## The VS Code extension cannot find abfc

The extension shows one message when no abfc is found and does not retry. It searches in a fixed order (setting `abfc.path`, `PATH`, an npm global install, the installer folder, then the workspace); the list is in [install.md](install.md#vs-code-extension). Fix it by opening a new VS Code window after changing `PATH`, or by setting `abfc.path` to the full path of `abfc.exe`, and run **abfc: Restart Language Server** from the command palette. In a workspace that is not trusted, `abfc.path` and the workspace copies are ignored until you grant trust.

## Publish is refused

`abfc publish` copies built assets into the mod. The backend refuses in a few cases, reported as [ABFC7005](errors.md#abfc7005) with the reason:

- **Play In Editor is running.** Stop it in the Mod Editor (abfc never does) and run `abfc publish` again. The exit code is 3.
- **Unsaved assets in the open Mod Editor.** Save or revert them in the editor, then run `abfc publish` again. A publish reloads assets in the open editor, which would lose unsaved changes, so it refuses first.
- **Locked files.** Another program, or an asset editor tab, holds the file; close the tab or the program.
- **The mod's files changed outside abfc since the last sync** (for example saved in the Mod Editor). Run `abfc publish` again: the build copies the mod again by itself (ABFC4017) and applies the TypeScript on top, so only edits made by hand to what the TypeScript owns are replaced.

[ABFC7006](errors.md#abfc7006) means the Mod Editor did not respond: close any dialog in it, run only one Mod Editor, and try again. abfc never closes your Mod Editor or clicks in it.

## My edits in the Mod Editor disappeared

That is by design: TypeScript wins. A build replaces what you changed by hand in an asset that a TypeScript class owns, and in a class without a `_Manual` merge it also removes hand-made nodes, functions and variables. The build prints one [ABFC5014](errors.md#abfc5014) warning per asset that lists what was replaced. The mod is also copied again when you saved in the Mod Editor ([ABFC4017](errors.md#abfc4017), a warning, nothing to do), and the TypeScript is applied on top. To keep a change, write it in the `.ts` file, or keep hand-made members in a hybrid class (`interface BP_X extends BP_X_Manual {}`, see [first-mod.md](first-mod.md#where-the-asset-goes)). `abfc status` shows what the next build would replace.

## A second build is refused (ABFC4019)

[ABFC4019](errors.md#abfc4019): another `abfc build`, `test`, `publish`, `status`, `generate` or `adopt` is running in the same project (the message gives its command and process id). Often it is a build from the editor's task while a terminal build is still going. Wait until it ends and run the command again. After a crash the next run replaces the dead lock by itself; delete `.abfc/lock.json` only if abfc names a process that certainly does not exist.

## A staged file is still in use

A build or publish can fail with a message like "the staged file BP_X.uasset is still in use after 60 s" (or, on older backends, `WinError 32`, "being used by another process"). A virus scanner, the search indexer, a hidden editor of a previous run that is still shutting down, or a second abfc run on the same mod holds the file. Nothing was changed. Wait a moment and run the command again; it was seen right after `abfc generate`. If it keeps happening, close other abfc runs and exclude the abfc runtime and headless folders from the scanner ([Antivirus](#antivirus-quarantine-or-locked-files)).

## The editor still lists a deleted asset

After `abfc publish` deleted the asset of a class you removed (or the old path of a renamed class), the open Mod Editor can keep showing it in the Content Browser or asset search, with no file behind it. The files are already gone from the mod. Restart the Mod Editor and the entries disappear; do not try to delete them again. This is a known limitation of the open editor's asset list ([known-issues.md](known-issues.md)).

## A struct stays after a rename (ABFC5018)

abfc never deletes a `@struct`, because Blueprints and saved games that use it would break. When you rename a struct or remove its file, the build warns once with [ABFC5018](errors.md#abfc5018) and the old struct stays in the mod next to the new one. Delete the old struct in the Mod Editor once nothing uses it, or declare it in TypeScript again.

## New gameplay tags are not known in the editor

After a `@director` with a new tag was published while the Mod Editor was open, [ABFC7015](errors.md#abfc7015) means the backend could not register the tag in the open editor (or is too old to try), which reads tags only at startup. Restart the Mod Editor before you use the tag there, and do not save a row the editor reports "Invalid Tags that have been removed" for; if you did, run `abfc build` and `abfc publish` again.


## The Epic login window of the stage audit

`abfc publish --full` runs the stage audit (gate 5) in a hidden Mod Editor. That editor may stop at an Epic Games login window and never finish; abfc then reports [ABFC7002](errors.md#abfc7002) once the audit gives up. The default `abfc publish` (without `--full`) does not run the audit and is unaffected. The audit is part of the upload check you run before putting a mod on mod.io, which abfc never does for you.

Status for 1.0: this is a known issue, investigated and not fixed. On the test machine the hidden editor always stopped at the login window, which offers "Login with Epic Games Store" and "Login with Mod.io". Waiting longer did not help: the backend gives up after 60 seconds by default, and a run with `ABF_LOGIN_GRACE=240` in the environment gave up after 240 seconds with the same window. The likely cause is that the Epic Games Launcher starts your normal Mod Editor with login arguments and the hidden editor, which abfc starts directly on a private desktop and profile, gets none and has no stored login to reuse. Having the Epic Games Launcher running or the Mod Editor open does not change that.

What you can do:

- Use the default `abfc publish` (without `--full`). It does not run the audit.
- Run the audit yourself in the Mod Editor before you upload: open the mod there and run the upload check (the Asset Audit). abfc never uploads for you, and this is the check that matters for mod.io.
- If you want to help: the backend keeps the hidden editor's log and a screenshot of the login window (`login_stuck.png`) in the run folder under its headless folder (the path is in `abfc doctor`). Attach the log lines that mention Epic, EOS or Login, without any tokens, to a bug report.

Signing in once in a normal Mod Editor session is the remedy the message suggests, but it did not help in the investigation. A fix needs a change in the backend (making the real local app data folder with the stored login visible to the hidden editor, or an opt-out for gate 5); it is not part of 1.0.
