# Error reference

Every problem abfc reports has a code of the form `ABFCnnnn`. This page explains each code: what it means, what usually causes it and how to fix it. The language server links each diagnostic to the section with the same code, and `abfc` prints the code in every message.

## How a message looks

A problem with a place in a TypeScript file is printed in the form editors and task problem matchers understand:

```
<file>:<line>:<col>: <severity> ABFCnnnn: <message>
```

A problem without a place starts with `abfc:` instead of the file position. The lines after it, when present, list what was tried (`tried:`) and one concrete step to take (`fix:`). With `--json` the same information is in the `diagnostics` array (see [cli.md](cli.md)).

`<severity>` is `error` or `warning`. A warning never changes the exit code; an error stops the command that raised it.

## Exit codes

The exit code of a command follows from the first error code that stopped it:

| Exit | Meaning | Codes |
| --- | --- | --- |
| 0 | The command succeeded (warnings may have been printed). | none |
| 1 | Your code or project is wrong: TypeScript subset errors, test and compile failures, publish refusals, ownership problems that are not conflicts, and the `abfc init` mistakes. | 1040-1044, 2000-2999, 5008 and up, 6000-6999, 7000 and up except 7005 and 7006 |
| 2 | The setup, the stubs or the backend is wrong, or the command line is wrong. | 1000-1999 except 1020 and 1040-1044, 3000-4999 except 4090, and 7006 |
| 3 | A conflict that needs your decision: the project sits in a mod folder, an edit in the editor to something abfc owns, or a publish refused because the editor is playing. | 1020, 4090, 5001-5007 and 7005 |

Each section below repeats the exit code of its code. A warning shows `Exit: -` because it does not end the command.

## 1xxx environment and config

Codes 1001-1006 are about finding the Mod Editor, the mods folder, Python and the backend. 1012-1031 cover the headless folder, the project folder and the config files. 1040-1044 belong to `abfc init`. 1050-1053 belong to the runtime folder of `abfc.exe`. Run `abfc doctor` first: it shows each setting with the place it came from. [troubleshooting.md](troubleshooting.md) has step-by-step help for the common cases.

### ABFC1001

Severity: error · Exit: 2

Meaning: the Mod Editor, or its executable, was not found.

Typical cause: the Mod Editor is not installed, or it is installed outside the places abfc looks (the Epic launcher's manifest files and the default install folders).

Fix: install the Mod Editor from the Epic Games Launcher, or give its folder with `--editor-root <folder>`, the environment variable `ABFC_EDITOR_ROOT`, or `"editor": {"root": "<folder>"}` in the user config. `abfc init` asks for the folder when it cannot find it.

### ABFC1002

Severity: error when no Documents folder can be found, warning when `abfc doctor` sees two different ones · Exit: 2 (error), - (warning)

Meaning: abfc could not find the Windows Documents folder, or the backend and abfc disagree about where it is.

Typical cause: Documents is redirected (OneDrive, another drive) and neither the Known Folder lookup nor the registry value gave a usable folder.

Fix: name the mods folder yourself with `--mods-dir`, `ABFC_MODS_DIR` or `modsDir` in the user config. See [OneDrive-redirected Documents](troubleshooting.md#onedrive-redirected-documents).

### ABFC1003

Severity: error · Exit: 2

Meaning: the mods folder (the one that holds one folder per mod) does not exist.

Typical cause: no mod was created in the Mod Editor yet, or the Documents folder is redirected and abfc looked in the wrong place.

Fix: create a mod in the Mod Editor, or set `--mods-dir`, `ABFC_MODS_DIR` or `modsDir` in the user config to the right folder. `abfc init` offers to enter the folder.

### ABFC1004

Severity: error · Exit: 2

Meaning: the folder of the mod was not found, so the stage cannot be created.

Typical cause: `mod.name` in `abf.config.json` is misspelled, the mod was renamed or deleted, or the mods folder is not the one that holds it. A mod folder must hold `<Mod>.uplugin`.

Fix: check `mod.name` in `abf.config.json`, or point to the folder with `--mod-dir` (or `ABFC_MOD_DIR`, or `"mod": {"dir": "<folder>"}`). Run `abfc doctor`.

### ABFC1005

Severity: error · Exit: 2

Meaning: Python 3.9 or newer was not found. The backend is a Python program.

Typical cause: a source install without Python on `PATH`, or only the Microsoft Store alias of Python, which cannot run scripts. `abfc.exe` brings its own Python and never raises this.

Fix: install Python 3.9 or newer from python.org, or set `ABFC_PYTHON` or `"backend": {"python": "<path>"}` in the user config. See [backend.md](backend.md).

### ABFC1006

Severity: error · Exit: 2

Meaning: the backend folder was not found; it must hold `server.py`.

Typical cause: a source install where the backend checkout was not given.

Fix: set `ABFC_BACKEND_DIR` (or `abfc init --backend-dir <folder>`) to your checkout of the backend. `abfc.exe` bundles a backend and does not need this. See [install.md](install.md#source-install).

### ABFC1012

Severity: error · Exit: 2

Meaning: the headless folder path contains a space.

Typical cause: a Windows user name with a space puts a space into `%LOCALAPPDATA%`, the default place of the headless folder. The Mod Editor launch cannot handle a space in that path.

Fix: set `ABF_HEADLESS_DIR` (or `--headless-dir`, or `headlessDir` in the user config) to a folder without spaces, for example `C:\abfc-headless`. See [User names with spaces](troubleshooting.md#user-names-with-spaces-and-the-headless-folder).

### ABFC1013

Severity: warning · Exit: -

Meaning: the headless folder path contains non-ASCII characters, or `abfc doctor` found that the backend uses a different headless folder than abfc resolved.

Typical cause: a user name with non-ASCII letters; or `ABF_HEADLESS_DIR` is set for one of the two programs only.

Fix: if the Mod Editor launch works, ignore the first case. Otherwise use an ASCII-only folder through `ABF_HEADLESS_DIR`; set the same value for both programs in the second case.

### ABFC1020

Severity: error · Exit: 3

Meaning: the project folder is inside a mod folder (a folder that holds a `*.uplugin` file, or one of its sub-folders).

Typical cause: the TypeScript project was created in the mod's own folder. abfc never writes into a mod folder; the mod is changed only through the backend.

Fix: move the project outside every mod folder, for example next to the mods folder, and run abfc there.

### ABFC1021

Severity: error when abfc cannot continue, warning from `abfc doctor` · Exit: 2 (error), - (warning)

Meaning: `abf.config.json` or the user config was not found or is not valid, or (as a warning) the project config holds machine-specific keys.

Typical cause: abfc was run outside a project, the file is not a JSON object, or it holds keys such as folder paths that belong on one machine only.

Fix: run abfc inside the project folder, or create `abf.config.json` with at least `{"mod": {"name": "<your mod>"}}`. For the warning, move the machine-specific keys to the user config so the project config can be committed. See [config.md](config.md).

### ABFC1022

Severity: error · Exit: 2

Meaning: a config file was written by a newer abfc; its `schemaVersion` is higher than this abfc reads.

Typical cause: the project (or user config) was created or upgraded with a newer abfc and is now opened with an older one.

Fix: update abfc. Do not edit `schemaVersion` by hand. See [config.md](config.md).

### ABFC1030

Severity: warning · Exit: -

Meaning: the Node.js version is not the supported one (Node 24).

Typical cause: a source install running on another Node version. `abfc.exe` carries its own Node.

Fix: install Node 24, which is the version abfc is tested on. Other versions may work, but a failure there is not covered.

### ABFC1031

Severity: warning · Exit: -

Meaning: `abf.config.json` uses the old schema 1.

Typical cause: the project was created with an early abfc.

Fix: run `abfc init` in the project folder. It upgrades the file to schema 2 and keeps the old one as `abf.config.json.v1.bak`. See [config.md](config.md).

### ABFC1040

Severity: error · Exit: 1

Meaning: `abfc init` was asked to create a project in a folder under another project (an ancestor folder holds `abf.config.json`).

Typical cause: running `abfc init` inside an existing project's folder tree.

Fix: choose a folder outside that project, or run `abfc init` in the existing project to repair it.

### ABFC1041

Severity: error · Exit: 1

Meaning: `abfc init` needs to ask a question but there is no terminal.

Typical cause: running `abfc init` from a script, a task or a pipe.

Fix: run it in a terminal, or give everything on the command line: `abfc init --mod <name> --yes`.

### ABFC1042

Severity: error · Exit: 1

Meaning: the mod named with `--mod` was not found in the mods folder, or its folder name has characters Unreal does not allow in asset paths (only `A-Z`, `a-z`, `0-9` and `_`).

Typical cause: a misspelled name, a mod created in another mods folder, or a mod name with a space or a dash.

Fix: pick one of the mods listed in the message with `--mod <name>`, or create the mod in the Mod Editor first. A mod whose name has other characters cannot be used with abfc.

### ABFC1043

Severity: warning · Exit: -

Meaning: the project's `tsconfig.json` does not extend `./.abfc/tsconfig.paths.json`.

Typical cause: an existing `tsconfig.json` was kept by `abfc init`, or the `extends` line was removed.

Fix: add `"extends": "./.abfc/tsconfig.paths.json"` at the top of `tsconfig.json`; the `@mod/` imports need it.

### ABFC1044

Severity: error · Exit: 1

Meaning: the mods folder holds no mod (no folder `<name>\<name>.uplugin`).

Typical cause: the Mod Editor has not been used to create a mod yet, or the mods folder is the wrong one.

Fix: create a mod in the Mod Editor first, or change the mods folder (the init prompt offers `c`, or use `--mods-dir`).

### ABFC1050

Severity: error · Exit: 2

Meaning: `abfc.exe` cannot create the folder it unpacks its runtime into.

Typical cause: no free disk space, no permission, or an antivirus program blocking the folder (`%LOCALAPPDATA%\abfc\runtime` by default).

Fix: free disk space, check the antivirus quarantine, close other abfc processes, then run `abfc doctor --deep`; or set `ABFC_RUNTIME_DIR` to another folder. See [antivirus](troubleshooting.md#antivirus-quarantine-or-locked-files).

### ABFC1051

Severity: error when the runtime folder is damaged, warning when `abfc doctor --clean-runtimes` leaves an old folder in place · Exit: 2 (error), - (warning)

Meaning: the runtime folder is damaged and cannot be replaced, or (warning) an old runtime folder is in use and was not removed.

Typical cause: another abfc process (a language server, a running build) holds files in the folder, or an antivirus program locks fresh files.

Fix: close other abfc processes and run `abfc doctor --deep`, or `abfc doctor --clean-runtimes` again later. See [damaged or stale runtime folder](troubleshooting.md#damaged-or-stale-runtime-folder).

### ABFC1052

Severity: error · Exit: 2

Meaning: the runtime archive inside `abfc.exe` does not match its manifest, or holds an entry the manifest does not list.

Typical cause: a damaged download or a modified `abfc.exe`.

Fix: reinstall abfc (installer or zip) and check the download against `SHA256SUMS.txt`. See [install.md](install.md).

### ABFC1053

Severity: warning · Exit: -

Meaning: `abfc.exe` uses a backend or a Python outside its own runtime folder.

Typical cause: an old `ABFC_BACKEND_DIR` or `ABFC_PYTHON` environment variable, or `backendDir` / `python` left in the user config or `abf.config.json` from a source install.

Fix: remove the old setting to use the bundled backend and Python, or keep it on purpose and ignore the warning. See [troubleshooting.md](troubleshooting.md#abfc1053-the-exe-uses-a-backend-outside-its-runtime).

## 2xxx TypeScript subset

These codes come from the compiler when it reads your TypeScript. abfc compiles a subset of TypeScript to Blueprint graphs; a construct outside the subset is reported with a code and the place in your source. Errors in this range exit with code 1. The editor shows them while you type when the language server is on ([language-service.md](language-service.md)).

### ABFC2000

Severity: error or warning, as TypeScript reports it · Exit: 1 (error), - (warning)

Meaning: a diagnostic of the TypeScript compiler itself (configuration, syntax, types), shown with the TypeScript message. Also a warning when a generated stub file cannot be read.

Typical cause: an ordinary type error or a missing import in your code; a stub file that is damaged or locked.

Fix: fix the code as the TypeScript message says. Some messages have a quick fix in the editor (for example `?.` for a possibly null value). Run `abfc stubs` to rewrite a stub file that cannot be read.

### ABFC2001

Severity: error · Exit: 1

Meaning: the `path` of a `@blueprint`, `@struct` or similar option is not a string literal under `/<Mod>/`.

Typical cause: the path is computed (a variable, a template with parts) or names another mod.

Fix: write the path as a plain string literal, relative to the mod (`path: "Samples/BP_Thing"`), or omit it to get the derived path (see [first-mod.md](first-mod.md)).

### ABFC2002

Severity: error · Exit: 1

Meaning: an asset path (explicit or derived from the file location and class name) breaks a rule: a class has no name, a folder or class name has characters other than letters, digits and `_` or is longer than 64 characters, or the whole package path is longer than 160 characters.

Typical cause: a deep source folder, a long class name, a space or a dash in a folder name, or an anonymous class.

Fix: rename the folder or class named in the message, shorten the path, or give an explicit short `path:`. See [Long paths](troubleshooting.md#long-paths).

### ABFC2003

Severity: error · Exit: 1

Meaning: a source file with a Blueprint class lies outside the source root, so abfc cannot derive its asset path.

Typical cause: the file is in the project root or another folder than the configured source folder (`src` by default).

Fix: move the file under the source folder, or give the class an explicit `path:`.

### ABFC2005

Severity: warning · Exit: -

Meaning: an explicit `path:` names the mod (`/<Mod>/...`) where a path relative to the mod is expected.

Typical cause: a path copied from the editor or from an older project.

Fix: write the path relative to the mod, as the message shows. The editor has a quick fix.

### ABFC2006

Severity: warning · Exit: -

Meaning: an explicit `path:` equals the path abfc derives from the file location anyway.

Typical cause: a path written by hand before derived paths existed.

Fix: remove the `path:` option (quick fix available). Keep it only when the asset must stay at a path that differs from the derived one.

### ABFC2007

Severity: error · Exit: 1

Meaning: two classes resolve to the same asset path (compared without case).

Typical cause: two classes with the same name in the same folder, or two explicit paths that collide.

Fix: rename one class, move it to another folder, or change its `path:`.

### ABFC2008

Severity: warning · Exit: -

Meaning: an import names the mod (`"/<Mod>/..."`) instead of using the `@mod/` alias.

Typical cause: an import written before the alias existed.

Fix: import through `"@mod/..."` (quick fix available).

### ABFC2010

Severity: error · Exit: 1

Meaning: `/` on integer values is not supported.

Typical cause: dividing two ints with `/`, which would be a float division in TypeScript but an integer division in Blueprint.

Fix: use `idiv(a, b)` for the Blueprint integer division (quick fix available), or convert to a float type first.

### ABFC2011

Severity: error · Exit: 1

Meaning: `==` and `!=` are not supported.

Typical cause: loose equality in the TypeScript source.

Fix: use `===` and `!==`.

### ABFC2012

Severity: error · Exit: 1

Meaning: an array index is not an int.

Typical cause: indexing or removing with a float or another number type.

Fix: pass an int (declare the variable as `int`).

### ABFC2013

Severity: error · Exit: 1

Meaning: two values of different Blueprint kinds are compared with `===` or `!==`.

Typical cause: comparing, for example, an int with a string or an object with a name.

Fix: convert one side so both have the same kind.

### ABFC2014

Severity: error · Exit: 1

Meaning: the Blueprint number kind of a parameter cannot be inferred from `number`.

Typical cause: a parameter typed `number` where the graph needs to know whether it is an int, int64, byte, float or double.

Fix: use one of the runtime type aliases (`int`, `int64`, `byte`, `float`, `double`) for the parameter.

### ABFC2015

Severity: error · Exit: 1

Meaning: a string is not a value of the enum the expression expects.

Typical cause: a misspelled enum value.

Fix: use one of the values listed in the message.

### ABFC2020

Severity: error · Exit: 1

Meaning: `try`, `catch`, `throw`, a local function or a local class is used inside a Blueprint method.

Typical cause: error handling or helper functions written inside a method body.

Fix: remove them; split the code into class methods, and handle errors with branches. Function locals are not supported yet.

### ABFC2040

Severity: error · Exit: 1

Meaning: a Map or Set method (or a container type) is not supported, for example iteration.

Typical cause: iterating a Map or Set, or calling a method other than `set`, `get`, `has`, `delete`, `clear`, `add` and `size`.

Fix: use only the supported methods (the message lists them), or keep the data in an array.

### ABFC2041

Severity: error · Exit: 1

Meaning: an array is changed somewhere other than as a statement on an own array variable.

Typical cause: `push` or `splice` on a local array or a parameter, or used as an expression.

Fix: keep the array as a field of the class and write `this.<Array>.push(x)`, `this.<Array>.splice(i, 1)` or `this.<Array>.length = 0` as statements.

### ABFC2042

Severity: error · Exit: 1

Meaning: a Map or Set is used other than through an own field.

Typical cause: a Map or Set held in a local variable or passed around.

Fix: declare it as a field of the class and use `this.<Field>.set(k, v)`, `.has(k)`, `.size`, and so on.

### ABFC2043

Severity: error · Exit: 1

Meaning: the type of a Map or Set field is not supported.

Typical cause: keys or set elements that are not int, int64, byte, name or string, or a map value that is itself a container.

Fix: use a supported key type and a single (non-container) value type.

### ABFC2044

Severity: error · Exit: 1

Meaning: the code uses a Map or Set type, or creates an asset of a kind, that the backend or abfc's current policy does not allow. It is reported before the stage is touched.

Typical cause: an older backend without Map or Set support, or a kind of asset the backend cannot create.

Fix: update the backend ([backend.md](backend.md)), or remove the Map, Set or asset kind.

### ABFC2046

Severity: error · Exit: 1

Meaning: a class is both a `@blueprint` and a `@struct`, or the fields of a `@struct` that already exists in the mod were changed.

Typical cause: two decorators on one class; or editing the fields of a struct after it was created.

Fix: use one decorator. For a changed struct, restore the fields or give the struct a new path and update the places that use it. Changing fields of an existing struct is not supported yet.

### ABFC2047

Severity: error · Exit: 1

Meaning: an own field cannot be declared as written, or the type of an existing own field was changed.

Typical cause: a field with an initializer or a modifier other than `public`, a type without a Blueprint equivalent, a name that collides with an inherited member; or changing the type of a field the asset already has.

Fix: declare the field as `Name!: Type;` with a supported type and a free name. For a type change, keep the type or rename the field (the old variable stays in the asset until you delete it in the Mod Editor).

### ABFC2050

Severity: error · Exit: 1

Meaning: the result of a cast must be used by the very next statement.

Typical cause: a cast stored in a variable that is used later, not in the following `if`.

Fix: test it right away: `if (!x)`, `if (x)` or `x?.`.

### ABFC2052

Severity: error · Exit: 1

Meaning: the result of a call with several execution outputs must be branched by the next statement.

Typical cause: storing the result and using it later.

Fix: branch on it in the next statement with `if (r.exec === "Pin")`.

### ABFC2053

Severity: error · Exit: 1

Meaning: `.exec` is used other than as `r.exec === "Pin"` or `r.exec !== "Pin"` in an `if` condition.

Typical cause: passing `.exec` on, or using it in a larger expression.

Fix: compare it with a pin name in an `if` condition only.

### ABFC2054

Severity: error · Exit: 1

Meaning: a delegate argument is not a reference to an own `@event` method.

Typical cause: passing an arrow function or another object's method.

Fix: pass `this.<Name>` where `<Name>` is an `@event` method of the same class.

### ABFC2055

Severity: error · Exit: 1

Meaning: an `@override` method has a different number of parameters than the parent function.

Typical cause: a parameter left out or added.

Fix: declare exactly the parameters the parent declares (the stub shows them).

### ABFC2056

Severity: error · Exit: 1

Meaning: the options of `spawnActor` are not a plain object literal of `key: value` entries.

Typical cause: passing a variable or spreading an object.

Fix: write the options inline, for example `{ ... }` with literal values.

### ABFC2060

Severity: error · Exit: 1

Meaning: the parent class has no Blueprint metadata (no `@bpPath`), so abfc cannot tell which class to derive from.

Typical cause: the stub of the parent class is missing or out of date.

Fix: run `abfc stubs` to regenerate the stubs, and check the import.

### ABFC2061

Severity: error · Exit: 1 (2 when raised while writing the class defaults)

Meaning: a `@blueprint` option or a `@director` argument is invalid: an unknown option value, `kind` other than `"widget"`, more than one `@director`, a row name that is not a string literal, `@director` together with `classManagerRow`, or a class default key or value the defaults pass does not accept.

Typical cause: a misspelled option or a computed value.

Fix: use the documented options with literal values, one `@director` per class, and not `classManagerRow` as well.

### ABFC2062

Severity: error · Exit: 1

Meaning: a `@blueprint` option that applies only to an Actor is used on a class that does not derive from Actor.

Typical cause: an Actor-only default (for example a replication setting) on a component or object class.

Fix: remove the option, or derive from Actor.

### ABFC2063

Severity: error · Exit: 1

Meaning: the `@blueprint` option `tickEnabled` is not supported yet.

Typical cause: setting `tickEnabled: true` or `false`.

Fix: remove the option and set tick on the class in the Mod Editor. Writing the saved start-with-tick default has not been verified.

### ABFC2064

Severity: error · Exit: 1

Meaning: the class has `kind: "widget"` but does not extend `UserWidget`.

Typical cause: the option was added to a class with another parent.

Fix: extend `UserWidget`, or remove `kind`.

### ABFC2065

Severity: error · Exit: 1

Meaning: the class extends `UserWidget` but has no `kind: "widget"` option.

Typical cause: a widget class declared like an ordinary `@blueprint`.

Fix: add `kind: "widget"` to the `@blueprint` options.

### ABFC2066

Severity: error · Exit: 1

Meaning: a member of a widget class has the name of a designer widget of the existing asset.

Typical cause: a field with the same name as a widget placed in the designer.

Fix: rename the variable. The designer layout stays hand-made; designer widgets are read-only members of the `_Manual` stub.

### ABFC2070

Severity: warning · Exit: -

Meaning: after the build, the class-manager row of a `@director` class does not reference the class.

Typical cause: the row was edited in the Mod Editor, or it belongs to another class.

Fix: run `abfc build` again; if the warning stays, fix the row in the Mod Editor, or change the `@director` row name.

### ABFC2071

Severity: warning · Exit: -

Meaning: the doc comment of an `@event` is not written as the event's Blueprint tooltip, because the backend does not support it.

Typical cause: an old backend without the `event_meta` feature.

Fix: update the backend ([backend.md](backend.md)), or ignore the missing tooltip.

### ABFC2072

Severity: warning · Exit: -

Meaning: the doc comment of an `@event` is longer than the limit; its tooltip, category or keywords are cut.

Typical cause: a long comment above the event.

Fix: shorten the doc comment to the length named in the message.

### ABFC2073

Severity: error · Exit: 1

Meaning: the row name given to `@director` is not a valid name.

Typical cause: a space, a dash or another character not allowed in an asset path segment, or a name that is too long.

Fix: use letters, digits and `_` only, within the length limit.

### ABFC2074

Severity: error · Exit: 1

Meaning: `@director` is used on a widget class or on a `@struct`.

Typical cause: copying a decorator from an Actor class.

Fix: remove it; `@director` applies to non-widget `@blueprint` classes only.

### ABFC2075

Severity: error · Exit: 1

Meaning: two classes use the same class-manager row.

Typical cause: a copied `@director("Row")`.

Fix: give each class its own row name.

### ABFC2076

Severity: warning · Exit: -

Meaning: the `classManagerRow` option is deprecated.

Typical cause: a class written for an earlier abfc.

Fix: replace it with `@director("RowName")` (quick fix available). See [first-mod.md](first-mod.md) and the CHANGELOG.

### ABFC2077

Severity: warning · Exit: -

Meaning: the backend cannot write class-manager rows, so the `@director` row is only checked and not written.

Typical cause: a backend older than 2.5.0 (source install).

Fix: update the backend to 2.5.0 or newer ([backend.md](backend.md)), or create the row in the Mod Editor. `abfc.exe` bundles a current backend.

### ABFC2099

Severity: error · Exit: 1

Meaning: a construct is not supported (the general "outside the subset" error), with the construct named in the message; also raised when the checked IR is invalid.

Typical cause: a statement, operator or class member that has no Blueprint equivalent yet.

Fix: rewrite the code with supported constructs, as the message says. If you think the construct should work, report it with the message and a small example.

### ABFC2101

Severity: error · Exit: 1

Meaning: a test body (the callback of `test(...)`) is not a block.

Typical cause: an expression-bodied arrow function.

Fix: use braces: `test("name", () => { ... })`.

### ABFC2102

Severity: error · Exit: 1

Meaning: a value in a test (a name, path or similar argument) is not a string literal.

Typical cause: a computed or concatenated string.

Fix: write the value as a plain string literal.
