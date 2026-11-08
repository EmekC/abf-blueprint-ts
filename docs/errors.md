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

The same code also reports a kept `tsconfig.json` that sets its own `"files"`. That list replaces the `"files": ["./tags.d.ts"]` of the extended `.abfc/tsconfig.paths.json`, so the generated gameplay tag constants (`.abfc/tags.d.ts`) are no longer part of the program. Add `"./.abfc/tags.d.ts"` to the `"files"` of `tsconfig.json`, or list it in `"include"`.

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

Severity: error · Exit: 1 (a field that cannot be declared as written); warning · Exit: - (the type of an existing field changed)

Meaning: an own field cannot be declared as written (error), or the type of an own field the asset already has was changed (warning: the build removes the variable and creates it again with the new type, and applies every unit of the class again because their get and set nodes carry the old type).

Typical cause: an initializer that is not a literal of the field type (or a default on a struct, object, array, Map, Set or text field, or an integer out of range for its type), `!` together with an initializer, a modifier other than `public`, a type without a Blueprint equivalent, a name that collides with an inherited member; or changing `Hits!: int;` to `Hits!: float;`.

Fix: for the error, declare the field as `Name!: Type;` or `Name: Type = <literal>;` (a number, `true`/`false`, a string or an enum value of the field type) with a supported type and a free name. For the warning nothing is required; values set on placed instances of the class are reset, and hand-made nodes (a class that merges with a `_Manual` interface) that use the variable may fail Unreal's compile (ABFC6001 names them).

### ABFC2048

Severity: error · Exit: 1

Meaning: the `extends` clause of a class whose asset already exists was changed, and abfc cannot apply the change. Two situations: the backend does not offer `bp_asset_ops` (older than 2.6.0), or the change crosses families (for example Actor to ActorComponent, which needs the asset to be created again) and the asset was not created by abfc, so recreating it would delete hand-made content.

Typical cause: the parent class was changed in TypeScript after the first build.

Fix: update abf-mod-editor-mcp to 2.6.0 (a parent in the same family is then reparented by the next build, a parent in another family recreates an asset abfc created), or restore the old `extends` clause. For an asset abfc did not create, delete it in the Mod Editor and build again.

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

### ABFC2078

Severity: error · Exit: 1

Meaning: an `@event` method has the name of an event or function of the parent class (or carries the TypeScript `override` modifier). `@event` creates a custom event, and Unreal refuses a custom event named like a native member (ABFC6001). The method is not built.

Typical cause: implementing `ReceiveBeginPlay` or `ReceiveTick` of the parent with `@event` instead of `@override`.

Fix: use `@override` to implement the parent's event (quick fix "Use @override" replaces the decorator, adds the `override` modifier and imports `override` from `@abfc/runtime`). Keep `@event` for new custom events with names the parent does not have.

### ABFC2079

Severity: warning · Exit: -

Meaning: `@director("Row")` has no gameplay tag. A new class-manager row then has no tag and the director never starts; an existing row keeps the tag it has.

Typical cause: the second argument of `@director` is missing.

Fix: add the tag, usually `ClassManager.EntityDirector.<Row>` (quick fix "Add the gameplay tag"): `@director("MyDirector", ClassManager.EntityDirector.MyDirector)` or a string literal. A tag that is not in the mod's tag list yet is added to `Config/Tags/<Mod>Tags.ini` by the build and published with the mod. Run `abfc stubs` once to generate the `ClassManager.EntityDirector.*` constants.

### ABFC2080

Severity: error · Exit: 1

Meaning: the gameplay tag of `@director` is not a string literal or a `GameplayTag` constant, or has characters Unreal tag names do not allow. The director is not built.

Typical cause: a tag held in a variable, a tag with a space, or a `ClassManager.EntityDirector.X` constant when the tags file was not generated yet.

Fix: write the tag as a string literal made of dotted segments of A-Z, a-z, 0-9, `_` and `-` (at most 200 characters), or run `abfc stubs` to generate the tag constants.

### ABFC2081

Severity: warning · Exit: -

Meaning: the gameplay tag of `@director` does not start with `ClassManager.EntityDirector.`. Every director the game knows uses that prefix; a director with another tag may never start.

Typical cause: a typo, or a tag copied from another feature.

Fix: use a tag under `ClassManager.EntityDirector.`, or ignore the warning if you know the game starts directors by another tag.

### ABFC2082

Severity: warning · Exit: -

Meaning: the backend cannot write gameplay tags, so the tag of `@director` is ignored (the row is written without it).

Typical cause: a backend older than 2.6.0 (source install).

Fix: update the backend to 2.6.0 or newer ([backend.md](backend.md)), or set the tag on the row in the Mod Editor. `abfc.exe` bundles a current backend.

### ABFC2083

Severity: error · Exit: 1

Meaning: `@override UserConstructionScript()` was written. The Blueprint Construction Script is not an event Unreal lets a graph override: the compile fails with "cannot be overridden and/or placed as event" (ABFC6001). The method is not built.

Typical cause: porting Blueprint logic that lived in the Construction Script.

Fix: move the logic to an `@override` of `ReceiveBeginPlay` (runtime) or to a custom `@event` you call yourself. The Construction Script of a class cannot be written in TypeScript.

### ABFC2084

Severity: warning · Exit: -

Meaning: the initializer of an own field that the asset already has was changed or removed (`Speed: float = 2.5;` to `= 4;`), but the backend cannot change the default of an existing variable (it lacks the bp_apply feature `variable_defaults`). The default in the asset stays as it is; the warning repeats on every build until the backend is updated.

Typical cause: an older abf-mod-editor-mcp backend.

Fix: update the backend ([backend.md](backend.md)); `abfc doctor` shows `variable defaults: yes` once it can. Or set the default in the Mod Editor.

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

## 3xxx stubs

The stubs are the `.d.ts` files `abfc stubs` writes from the Mod Editor; the lock file next to them records which editor build and configuration they belong to. These codes mean the stubs are missing, out of date or incomplete. They all exit with 2.

### ABFC3001

Severity: error in `abfc build` and `abfc publish`, warning in `abfc check` · Exit: 2 (error), - (warning). The generator-version variant is always a warning.

Meaning: the stubs were generated for a different Mod Editor install than the one abfc finds now. Or, as a warning only: the stubs were generated by an older `abfc stubs` than the abfc that is running (the message names both versions), so they lack what newer versions add (default arguments of library functions, the gameplay tag declarations).

Typical cause: the Mod Editor was updated or reinstalled after `abfc stubs` ran, or abfc was updated and `abfc stubs` was not run again.

Fix: run `abfc stubs` again.

### ABFC3002

Severity: error · Exit: 2

Meaning: there is no abfc profile for the Mod Editor build that was found, or the stubs belong to a different profile than the one abfc uses now.

Typical cause: a Mod Editor build newer than this abfc release knows, or stubs copied from a project that used another profile. `abfc doctor` shows a similar warning when it cannot confirm the build at all.

Fix: update abfc when the build is unknown to it, then run `abfc stubs`. `abfc doctor` shows which build was detected.

### ABFC3003

Severity: error when the stubs do not exist, warning when a configured class is missing from them · Exit: 2 (error), - (warning)

Meaning: there is no `stubs.lock.json` for this editor build, or the stubs do not cover every class listed in `stubs.classes` and `stubs.scriptClasses`.

Typical cause: `abfc stubs` was never run in this project, or a class was added to the config afterwards.

Fix: run `abfc stubs`.

### ABFC3004

Severity: warning in `abfc stubs`, error in a build · Exit: 2 (error), - (warning)

Meaning: abfc could not determine the cast pin for a class, so a cast to that class (`as`, or a type test that casts) cannot be built.

Typical cause: the class is not in the stubs, or the backend did not report how to cast to it.

Fix: add the class to `stubs.classes` or `stubs.scriptClasses` and run `abfc stubs`. If the warning stays, report the class name.

### ABFC3010

Severity: warning · Exit: -

Meaning: `stubs.scriptModules` in the config is ignored in this version.

Typical cause: whole-module reflection is too slow to offer, so the setting has no effect yet.

Fix: list the classes you need in `stubs.scriptClasses` instead. See [config.md](config.md).

### ABFC3011

Severity: warning · Exit: -

Meaning: an entry in `stubs.widgetMembers` names a widget class that is not in the stubs, so the member is typed as a plain `UObject`.

Typical cause: the widget class is missing from `stubs.scriptClasses`.

Fix: add the class named in the message to `stubs.scriptClasses` and run `abfc stubs`.

### ABFC3012

Severity: warning · Exit: -

Meaning: the backend cannot list the game's gameplay tags, so `abfc stubs` could not store them. `.abfc/tags.d.ts` (the typed tag constants and the tag names the `director` decorator suggests) then holds only the tags of the mod's own `Config/Tags` files.

Typical cause: abf-mod-editor-mcp older than 2.6.0.

Fix: update abf-mod-editor-mcp to 2.6.0 or newer (or use the bundled backend of `abfc.exe`) and run `abfc stubs` again. Until then a tag can still be written as a string literal.

## 4xxx backend

The backend is the part of abfc that talks to the Mod Editor (the bundled one in `abfc.exe`, or an abf-mod-editor-mcp checkout in a source install). See [backend.md](backend.md). Except ABFC4090, these codes exit with 2.

### ABFC4001

Severity: error · Exit: 2

Meaning: the backend speaks an older protocol than this abfc needs.

Typical cause: a source install that uses an old abf-mod-editor-mcp checkout.

Fix: update the checkout, or use `abfc.exe`, which bundles a matching backend. `abfc doctor` shows the backend it found.

### ABFC4002

Severity: error, or warning in `abfc stubs` · Exit: 2 (error), - (warning)

Meaning: a backend tool failed, or the command hit an unexpected failure. The message carries the backend's own text.

Typical cause: the Mod Editor is not reachable, a path in the request does not exist, or the backend raised an error. `abfc stubs` shows it as a warning for a mod asset that is not a Blueprint.

Fix: read the text after `[backend]` or `failed:`. Run `abfc doctor --verbose` to check the backend folder and Python, and try again. If the message is about the stage, `abfc build --resync` rebuilds it.

### ABFC4003

Severity: error · Exit: 2

Meaning: the two-phase fallback (the slower route abfc uses for wildcard pins on a backend without `backend_info`) needed a file that the backend did not write.

Typical cause: an old backend checkout.

Fix: update the backend (see [backend.md](backend.md)), or use `abfc.exe`.

### ABFC4004

Severity: error · Exit: 2

Meaning: the two-phase fallback could not match every wildcard pin, or found no real node name for a planned node.

Typical cause: the editor's export text differs from what the patcher expects, usually with an old backend.

Fix: update the backend. If it persists with a current one, report it with the message.

### ABFC4010

Severity: error · Exit: 2

Meaning: abfc built a pin type that the backend refuses, or a struct member name that is not of the form `<Field>_<index>_<GUID>` (internal error).

Typical cause: an abfc bug or a version mismatch between abfc and the backend. For a struct member name, the struct in the stage was created or changed in a way abfc did not expect.

Fix: report it with the message and the node or struct member it names. Updating abfc and the backend to matching versions may help.

### ABFC4011

Severity: error · Exit: 2

Meaning: the backend has no `reflect` tool, which `abfc stubs` needs.

Typical cause: a source install with an old abf-mod-editor-mcp checkout.

Fix: update the checkout (see [backend.md](backend.md)) or use `abfc.exe`.

### ABFC4012

Severity: warning · Exit: -

Meaning: the backend has no `backend_info` tool, so abfc cannot read its capabilities.

Typical cause: an old abf-mod-editor-mcp checkout.

Fix: update the backend. Until then abfc uses the slower two-phase route for wildcard pins, which costs about 10 to 20 seconds more per build.

### ABFC4013

Severity: error · Exit: 2

Meaning: the code calls an event that is new in this build, and the backend cannot create and call a new event in one step.

Typical cause: an older backend, without the `self_event_calls` feature of `bp_apply`.

Fix: update the backend, or build once without the call and add the call in a second build.

### ABFC4014

Severity: warning · Exit: -

Meaning: the backend is older than the minimum version this abfc is built for (2.4.0).

Typical cause: a source install with an old abf-mod-editor-mcp checkout.

Fix: update the checkout, or use `abfc.exe`. See [backend.md](backend.md).

### ABFC4015

Severity: error · Exit: 2

Meaning: a unit needs an event to supply a delegate, and that event is neither in this build nor recorded as built earlier.

Typical cause: the event belongs to a unit that was removed, or that failed to build in an earlier run.

Fix: declare the event in TypeScript again, or remove the use of it, then run `abfc build`. If the event is a hand-made one in the Blueprint, declare it in TypeScript under the same name: the build replaces the hand-made event (TypeScript wins).

### ABFC4016

Severity: warning · Exit: -

Meaning: a build failed to compile in Unreal, and abfc then could not restore the staged copy from the mod. The build had already failed; this is an extra problem.

Typical cause: the mod folder is locked, the backend stopped responding or the disk is full.

Fix: run `abfc build --resync` before the next build. That discards all unpublished work in the staged copy, in every asset of the mod and not only the assets that failed to compile; the next build applies the units again. `--keep-failed-stage` keeps the failed stage for inspection instead (see [cli.md](cli.md)).

### ABFC4017

Severity: warning · Exit: -

Meaning: the real mod changed since abfc made its staged copy, so abfc copied the mod again before it went on (`abfc build`, `abfc test`, `abfc publish`, `abfc stubs`). The message lists up to 10 of the files. The TypeScript is applied on top of the fresh copy (TypeScript wins).

Typical cause: you saved the mod in the Mod Editor, or published by hand, after the stage was made.

Fix: nothing is required. The staged copy only holds abfc's own work, which the build generates again from the TypeScript. Edits you made by hand in the Mod Editor to what the TypeScript owns are replaced and reported as [ABFC5014](errors.md#abfc5014).

### ABFC4018

Severity: warning · Exit: - (`abfc doctor` only)

Meaning: the backend is older than the version abfc recommends (2.6.0), or it does not report one of the capabilities `assetOps`, `publishDeletes`, `gameplayTags` and `reflectDefaults`. The message lists the missing ones. Everything still works: without `assetOps` a renamed or moved class stays [ABFC5012](errors.md#abfc5012); without `publishDeletes` a publish does not delete files ([ABFC7014](errors.md#abfc7014)); without `gameplayTags` the editor offers only the tags of your mod ([ABFC3012](errors.md#abfc3012)); without `reflectDefaults` the default values of function parameters are not read from the editor.

Typical cause: a source install with an old abf-mod-editor-mcp checkout.

Fix: update the checkout to tag `v2.6.0` or newer, or use `abfc.exe`, which bundles a current backend. See [backend.md](backend.md).

### ABFC4020

Severity: warning (`abfc status`); error · Exit: 2 (only if the conflict remains after the staged copy was made again)

Meaning: `abfc status` found that the real mod changed since the staged copy was made. Status never discards anything; the next `abfc build` copies the mod again ([ABFC4017](errors.md#abfc4017)). As an error it means the conflict was still there after that copy.

Typical cause: the mod's files changed after the stage was made, for example the mod was saved in the Mod Editor, or published by hand. As an error: another program is writing to the mod folder.

Fix: nothing for the warning. For the error, close the programs that write to the mod folder, then run the command again.

### ABFC4090

Severity: error · Exit: 3

Meaning: abfc refused to call a backend tool outside its allowlist, or to publish outside `abfc publish` or for another mod than the project's own.

Typical cause: this should not happen in normal use. It is a safety check that protects the real mod from commands that must not write to it.

Fix: use the command that does the work (`abfc publish` to write the mod). If you did not ask for anything unusual, report the message.

### ABFC4100

Severity: error · Exit: 2

Meaning: the backend refused to write one asset graph in memory.

Typical cause: the graph has a shape the in-memory writer does not support yet.

Fix: report it with the run folder named in the message. Building a smaller unit may avoid it meanwhile.

## 5xxx ownership and drift

TypeScript wins: a build (and a publish, which builds) makes the Blueprint match the `.ts` file. What was changed in the Mod Editor is replaced, and in a class without a `_Manual` interface merge the hand-made nodes, function graphs and variables are removed; one ABFC5014 warning per asset lists what went. Event dispatchers, macros, components and the widget tree are kept. Codes 5001-5004 are only warnings now (`abfc status` previews them); 5005-5007 need your decision and exit with 3; the rest exit with 1 (errors) or do not end the command (warnings). The workflow is described in [first-mod.md](first-mod.md) and the commands in [cli.md](cli.md).

### ABFC5001

Severity: warning (`abfc status`) · Exit: -

Meaning: a unit that abfc built was edited in the Mod Editor since the last build, or the staged copy differs from what abfc applied. The next build replaces it (TypeScript wins); [ABFC5014](#abfc5014) lists it then. The message counts the nodes and links that changed.

Typical cause: you changed, moved or reconnected a generated node in the Blueprint editor, or the stage was re-synced from a mod that holds a different version.

Fix: nothing is required. To keep the edit, move it into the `.ts` file before building.

### ABFC5002

Severity: warning (`abfc status`); error · Exit 3 (`abfc adopt`)

Meaning: nodes that abfc owns are missing from the asset. The next build applies the unit again (TypeScript wins). The same code is an error of `abfc adopt` when the unit to adopt does not exist in the asset.

Typical cause: you deleted generated nodes in the editor, or the stage was re-synced from a mod that never had them.

Fix: nothing is required for a build. For `abfc adopt`, check the name of the event.

### ABFC5003

Severity: warning (`abfc status`) · Exit: -

Meaning: an event or override declared in TypeScript already exists in the asset as a hand-made event. The next build replaces it (TypeScript wins).

Typical cause: the event was made in the Blueprint editor before it was written in TypeScript.

Fix: nothing is required. To keep the hand-made event, rename the TypeScript method.

### ABFC5004

Severity: warning (`abfc status`) · Exit: -

Meaning: a hand-made unit that was adopted earlier changed in the real mod, so the recorded adoption no longer matches. The next build replaces it with the TypeScript unit.

Typical cause: someone edited the adopted nodes in the editor after `abfc adopt` recorded them.

Fix: nothing is required.

### ABFC5005

Severity: error · Exit: 3

Meaning: the unit cannot be adopted because it shares nodes with another unit, has links to nodes outside it, or an outside node uses its entry as a delegate.

Typical cause: hand-made graphs often reuse nodes between events.

Fix: split the shared nodes in the editor, or adopt the unit that holds the delegate user first, then run `abfc adopt` again.

### ABFC5006

Severity: error · Exit: 3

Meaning: `abfc adopt` shows what it would take over and stops, because it was not told to go on. Nothing was written.

Typical cause: `--yes` was not given.

Fix: check the number of nodes in the message, then run the command from the fix line with `--yes`.

### ABFC5007

Severity: error · Exit: 3

Meaning: the unit was already applied by abfc, so adopting it again would replace the generated nodes and discard edits made to them in the editor. Nothing was written.

Typical cause: `abfc adopt` was run for a unit that abfc built itself.

Fix: if you really want the hand-made version, run the command from the fix line with `--yes --discard-editor-changes`. Otherwise, leave the unit to abfc.

### ABFC5008

Severity: error · Exit: 1

Meaning: `--remove-node` named a node that does not exist, or one that is not a comment box and has linked pins.

Typical cause: a mistyped node name, or a node that is still part of the graph.

Fix: use the name of a comment box or of a node with no links, as listed in the message.

### ABFC5009

Severity: error · Exit: 1

Meaning: a unit that is no longer declared in TypeScript is still called by another unit, or (a class that merges with its `_Manual` interface) by a hand-made node that is kept.

Typical cause: a method or event was deleted or renamed while a call to it remains.

Fix: change the call in the unit named in the message, or declare the method again.

### ABFC5010

Severity: warning · Exit: -

Meaning: a Blueprint class is no longer declared in TypeScript. abfc removes the units it owns, but the class defaults it set stay as they are.

Typical cause: the class file was deleted.

Fix: nothing is required. Clean up the asset in the Mod Editor if you do not want it.

### ABFC5011

Severity: warning · Exit: -

Meaning: a field that was declared in TypeScript before is gone, so the build removed the variable from the Blueprint.

Typical cause: a property was deleted from the class.

Fix: nothing is required; declare the field again to get it back.

### ABFC5012

Severity: warning (one earlier asset of a class, in `abfc check` and the language server) · error (several earlier assets, a `@struct`, or a backend without `bp_asset_ops`) · Exit: 1 for the error

Meaning: a class file now gives a different asset path than the one it was built as (the file moved or the class was renamed), and the old asset is still recorded. abfc never creates a second asset and retires the first. With one earlier asset of a class and a backend that supports it (2.6.0), the next `abfc build` renames the asset (references are fixed by Unreal), and `abfc check` only warns. Otherwise it is an error.

Typical cause: a `.ts` file was moved, or a class renamed, without a `path` option in `@blueprint`; several candidates when more than one earlier asset has the class name or file.

Fix: for the error, keep one earlier asset with `path: "<path below the mod>"` in the class options (the editor quick fix does it), move the file back, or update the backend. The language server offers the quick fix on the diagnostic.

### ABFC5013

Severity: warning · Exit: -

Meaning: the class-manager row that a previous build wrote for a `@director` class stays in the mod, because the class no longer names that row.

Typical cause: the row name in `@director` was changed or removed.

Fix: delete the old row in the Mod Editor.

### ABFC5014

Severity: warning · Exit: -

Meaning: TypeScript wins. This build replaced or removed what was changed or made by hand in the Mod Editor in one Blueprint: edited or deleted generated units (with the old ABFC5001/5002/5004 details), a hand-made event of the same name as a TypeScript event, and, in a class without a `_Manual` interface merge, every other hand-made node (the count and the first five names per graph), function graph and variable. Event dispatchers, macros, components, the widget tree, interface functions and disabled engine default events are kept.

Typical cause: you changed the Blueprint in the Mod Editor and did not move the change into the `.ts` file.

Fix: nothing is required. To keep a change, move it into the `.ts` file before building; `abfc status` previews what the next build replaces. `abfc build --drift` and the build inside `abfc publish --full` read every owned asset, so they replace editor changes in unchanged assets too.

### ABFC5015

Severity: warning · Exit: -

Meaning: `abfc adopt` is not needed any more. `abfc build` replaces a hand-made event or override of the same name as a TypeScript unit on its own (TypeScript wins, [ABFC5014](errors.md#abfc5014)). The command still works and is kept for compatibility.

Typical cause: you ran `abfc adopt`, as older versions of the documentation advised.

Fix: declare the event in TypeScript and run `abfc build`. Use `abfc adopt` only if you want the hand-made nodes to stay as they are until the first build.

### ABFC5016

Severity: error · Exit: 1

Meaning: the backend could not perform a stage operation that `abfc build` needs for a renamed or moved class, a class that left the TypeScript, or a changed `extends` clause (rename, delete, reparent or recreate of an asset). The backend restored the stage, so nothing was changed. The message names the operation and the backend's reason, for example an asset that still references a deleted asset, or a rename target that already exists.

A delete runs after the build applied the new specs of the classes that used the removed class, so removing a class and its last use in TypeScript in one edit works in one build. If a delete fails then, the applied changes stay on the stage (only the delete is rolled back) and the next build tries the delete again.

Typical cause: another Blueprint of the mod still uses an asset whose class you removed; a hand-made asset already sits at the new path of a moved class.

Fix: remove the reference or the asset in the Mod Editor, or keep a moved class where it was with `path: "<its path below the mod>"`; then run `abfc build` again.

### ABFC5101

Severity: warning · Exit: -

Meaning: the pass that adds abfc's ownership comment boxes failed for an asset. The units were applied but carry no comment box.

Typical cause: a temporary backend or compile problem during the second pass.

Fix: run `abfc build` again. The pass is repeated.

### ABFC5102

Severity: warning · Exit: -

Meaning: the pass that sets class defaults failed for an asset, or the backend did not confirm the class-manager row. The defaults are not applied or not confirmed.

Typical cause: a temporary backend or compile problem during the defaults pass.

Fix: run `abfc build` again. The pass is repeated.

## 6xxx tests

Codes 6001 and 6002 are Unreal compile errors reported after a build applied the Blueprints. 6101-6201 come from `abfc test` and from the test gate of `abfc publish`. They exit with 1 when they are errors. Writing tests is covered in [first-mod.md](first-mod.md).

### ABFC6001

Severity: error · Exit: 1

Meaning: Unreal reported a compile error for generated nodes, and abfc found the TypeScript line that made them. The message starts with `[Unreal]`.

Typical cause: a construct that compiles in TypeScript but not in Blueprint, for example a type that does not fit a pin.

Fix: fix the line shown. `abfc build --keep-failed-stage` keeps the failed stage so you can look at the Blueprint.

### ABFC6002

Severity: error · Exit: 1

Meaning: Unreal reported a compile error that abfc could not map to a TypeScript line, or one in a hand-made node.

Typical cause: an error in a node abfc does not own, or a message without a node.

Fix: read the message. For a hand-made node, fix it in the Mod Editor. After a failed compile abfc re-syncs the stage from the mod, so the next build applies your units again; `--keep-failed-stage` keeps the failed stage instead.

### ABFC6101

Severity: error · Exit: 1

Meaning: a test step failed: the value read from the game did not match the expected one.

Typical cause: the code under test does not behave as the test expects.

Fix: the message shows the expectation and the value that was read, and the diagnostic points at the failing step. Fix the code or the test. For a bug you want to keep for now, mark the step with `knownIssue(reason)` on the assertion.

### ABFC6102

Severity: warning · Exit: -

Meaning: a step marked as a known issue still fails.

Typical cause: the pre-existing problem is still there.

Fix: nothing is required. The warning keeps the issue visible.

### ABFC6103

Severity: warning · Exit: -

Meaning: a step marked as a known issue passes now.

Typical cause: the underlying problem was fixed.

Fix: remove the `knownIssue` mark from the step.

### ABFC6104

Severity: error · Exit: 1

Meaning: a test did not finish (it was incomplete or timed out), or one or more tests failed, so a command that needs tests to pass (`abfc publish`) stops.

Typical cause: the test waits for something that never happens, or the game test run was interrupted. A summary line is added when tests fail.

Fix: read the message for the test name and the reason, and run `abfc test <name>` alone. Fix the code the test waits for.

### ABFC6105

Severity: warning · Exit: -

Meaning: a `liveHud` test is skipped, because it needs a live HUD and cannot run hidden.

Typical cause: the test was written with `test.liveHud`.

Fix: nothing is required. abfc lists the test and its checklist in `.abfc/reports/manual-checks.md` for a manual check in Play In Editor. Skipped live tests do not stop `abfc publish`.

### ABFC6201

Severity: warning · Exit: -

Meaning: the game printed a log line (a warning or error) while a test ran.

Typical cause: a runtime problem in the code under test, such as an access to a null reference.

Fix: read the log line. It is shown even when the test passes, because it may point at a real problem.

## 7xxx publish

`abfc publish` runs seven gates and then copies the staged copy into the real mod. These codes explain why a gate or the copy stopped. See [troubleshooting.md](troubleshooting.md#publish-is-refused) for the recovery steps and [cli.md](cli.md) for the gates.

### ABFC7002

Severity: error · Exit: 1

Meaning: the stage audit (gate 5, `mod_audit`) did not pass for the mod, or it audited the real copy instead of the staged copy.

Typical cause: the audit found a problem in the staged mod, or the hidden Mod Editor that runs it stopped at the Epic Games login window and gave up. The second case is a known issue (the login window did not clear in two live runs, with waits of 60 and 240 seconds): see [the Epic login window](troubleshooting.md#the-epic-login-window-of-the-stage-audit).

Fix: run `mod_audit` in the Mod Editor for the details. The stage audit runs only for `abfc publish --full`; the default `abfc publish` does not need it.

### ABFC7003

Severity: warning · Exit: -

Meaning: the backend audits the real mod, not the staged copy, so the audit does not cover the staged changes.

Typical cause: an older backend without the `stageAudit` capability.

Fix: update the backend ([backend.md](backend.md)), or audit the mod in the editor after publishing.

### ABFC7004

Severity: error · Exit: 1

Meaning: the backend refused to publish because the staged copy has compile errors.

Typical cause: an earlier build left errors in the stage.

Fix: fix the errors listed, run `abfc build`, then run `abfc publish` again.

### ABFC7005

Severity: error · Exit: 3

Meaning: the backend refused to copy the files because the mod or the open Mod Editor is in a state that needs your action: the mod changed outside abfc, assets have unsaved changes, assets are open in the editor, Play In Editor is running, or a file is locked.

Typical cause: you saved the mod in the Mod Editor after the stage was made, or left an asset editor tab open.

Fix: the fix line names the case. Typical steps: run `abfc publish` again after the mod changed (the build copies the mod again by itself), save or revert the assets in the Mod Editor, stop Play In Editor, or close the asset tabs, then run `abfc publish` again. abfc never closes your Mod Editor.

### ABFC7006

Severity: error · Exit: 2

Meaning: the publish could not complete because of the Mod Editor or the machine: the editor did not respond, is in a bad state, a backup or copy failed, or the reload failed.

Typical cause: a dialog is open in the Mod Editor, two Mod Editors run, or the disk is full.

Fix: close any dialog in the Mod Editor, run only one editor, check the free disk space and the headless folder, then run `abfc publish` again. When a copy failed and the mod was not restored, the message names the backup folder to copy the files back from.

### ABFC7010

Severity: error · Exit: 1

Meaning: the mod or stage folder holds a `.md` file, which mod.io rejects when the mod is uploaded.

Typical cause: a README or notes file in the mod folder.

Fix: move the file out of the mod folder.

### ABFC7011

Severity: error · Exit: 1

Meaning: the code uses a member that the Blueprint filter blocks. The upload check of the Mod Editor would reject a node for it.

Typical cause: a stub member tagged `@deprecated Blocked by Blueprint filter`.

Fix: use another member. If you know the audit accepts it, report the member so it can be added to the profile's `filterOverrides`.

### ABFC7012

Severity: warning · Exit: -

Meaning: the mod or stage folder holds a file of a type the templates do not contain, or a file inside an editor working folder. It would be zipped and uploaded with the mod.

Typical cause: leftover files from a tool or a backup copy.

Fix: remove the file if you do not want to ship it.

### ABFC7013

Severity: warning · Exit: -

Meaning: after the publish, the open Mod Editor logged Blueprint compile errors while it reloaded the published assets. The files on disk are fine; the errors are in the editor's memory.

Typical cause: the editor reloaded assets that other loaded assets still referenced.

Fix: open the listed Blueprints and compile them again, or restart the Mod Editor.

### ABFC7014

Severity: warning · Exit: -

Meaning: the publish has files to delete from the mod (the asset of a deleted class and its class-manager row, the old path of a renamed or moved class, a retired class-manager row), but the backend cannot delete files (capability `publishDeletes`, backend 2.6.0 or newer). Everything else is published; the listed assets stay in the mod, and abfc keeps the deletions pending (the deleted class's tombstone and the renamed asset's `renamedFrom`), so the next publish with a newer backend deletes them.

Typical cause: an older abf-mod-editor-mcp.

Fix: delete the listed assets in the Mod Editor (Content Browser), or update abf-mod-editor-mcp to 2.6.0 or newer and run `abfc publish` again.

### ABFC7015

Severity: warning · Exit: -

Meaning: the publish copied the mod's gameplay tag list (`Config/Tags/<Mod>Tags.ini`, new tags added by a `@director` tag) while the Mod Editor was open. The editor reads gameplay tags when it starts, so it does not know the new tags yet; the file on disk is fine.

Typical cause: a `@director` with a tag that was not in the mod's tag list, published with the editor open.

Fix: restart the Mod Editor before you use the new tags there, and do not save the mod in the editor before that.

## Lint rules

The rules of the ESLint plugin (`abfc/no-heavy-call-in-tick` and the others) report under their rule name and have no `ABFC` code. They are described in [lint-rules.md](lint-rules.md).
