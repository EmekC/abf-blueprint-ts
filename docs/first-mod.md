# Your first mod

This walk-through takes you from an installed abfc ([install.md](install.md)) to a Blueprint written in TypeScript, running in a test and published into your mod. It uses the sample that `abfc init` writes. The mod is called `ExampleMod` here; use the name of your own mod.

## 1. Create the mod in the Mod Editor

abfc builds Blueprints into an existing mod; it does not create mods. Open the Abiotic Factor Mod Editor from the Epic Games Launcher and create a new mod there. Save it and give it a name made of letters, digits and underscores, for example `ExampleMod`. The editor puts it into `<Documents>\Abiotic Factor Mods\ExampleMod`.

You may keep the Mod Editor open while you work with abfc. Everything abfc asks of it goes through the backend, never through mouse or keyboard input, and abfc never closes it.

## 2. Make a project folder

The TypeScript project lives in its own folder, outside the mods folder and outside the mod. Keep the path short ([troubleshooting.md](troubleshooting.md#long-paths)):

```
mkdir C:\abfc\ExampleMod
cd C:\abfc\ExampleMod
```

## 3. `abfc init`

```
abfc init
```

`abfc init` finds the Mod Editor and the mods folder, lists the mods it sees, and asks which one to link. The prompt looks like this:

```
Mod Editor: C:\Program Files\Epic Games\AbioticFactorModEditXXXX  (Epic manifest)
Mods folder: C:\Users\<you>\Documents\Abiotic Factor Mods  (auto)
  1) ExampleMod        "Example Mod"         12 assets
  2) OtherMod          "Other Mod"            3 assets
  c) change the mods folder and rescan
  q) quit without writing anything
Link which mod? [1-2, c, q]:
```

Choose the number of your mod (`c` changes the mods folder, `q` quits). It then lists the files it will write and asks `Write these files? [y/N]`. Nothing is written before you answer `y`.

Without a terminal, or to skip the questions, name the mod:

```
abfc init --mod ExampleMod --yes
```

What `abfc init` writes:

- in the project folder: `abf.config.json` (the mod name and the stub settings, see [config.md](config.md)), `tsconfig.json`, `.gitignore`, `.vscode\tasks.json` and `.vscode\extensions.json` (only when absent), and the sample `src\Samples\BP_HelloAbfc.ts` with its test `src\Samples\BP_HelloAbfc.test.ts` (only when `src` holds no TypeScript file yet);
- one per-machine file, the user config (`%APPDATA%\abfc\config.json`), with the Mod Editor folder and the mods folder;
- then it generates the stubs (the `.d.ts` files that describe the engine and your mod's assets to TypeScript; add `--no-stubs` to skip) and prints the `abfc doctor` checklist.

It never writes into the mods folder or the mod. Running it again changes nothing.

## 4. The sample

`src\Samples\BP_HelloAbfc.ts`:

```ts
import { blueprint, event } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/Engine";

@blueprint()
export class BP_HelloAbfc extends Actor {
  Count!: int;

  /** Adds one to Count. */
  @event
  Bump(): void {
    this.Count = this.Count + 1;
  }
}
```

It is an Actor Blueprint with an integer variable and one custom event. The test next to it spawns the actor, calls `Bump` twice and expects `Count` to be 2.

### Where the asset goes

You never write the asset path. It comes from the folder of the file below `src`: `src\Samples\BP_HelloAbfc.ts` builds `/ExampleMod/Samples/BP_HelloAbfc`, and a file `src\Relays\MyCustomRelay.ts` with `class MyCustomRelay` would build `/ExampleMod/Relays/MyCustomRelay`. A file directly in `src` gives `/ExampleMod/<ClassName>`. Folder and class names may use ASCII letters, digits and `_` only. Moving a file later is a different asset path, which abfc refuses to guess; see [ABFC5012](errors.md#abfc5012).

## 5. Check, build, test

```
abfc check
abfc build
abfc test
```

- `abfc check` compiles the TypeScript and reports errors and warnings. It needs no Mod Editor session and is fast.
- `abfc build` turns the classes into Blueprint graphs in a private staging copy of the mod, and compiles them in Unreal. Your mod is not changed yet. The first build starts the backend and takes longer.
- `abfc test` builds, then runs the `*.test.ts` files inside a real game session started by the backend and prints the results. Tests do not change your mod either.

## 6. Publish

Look first at what would be copied, then do it:

```
abfc publish --dry-run
abfc publish
```

`--dry-run` builds and lists the assets `abfc publish` would copy into the mod, then stops. `abfc publish` copies exactly those assets into `<mods folder>\ExampleMod\Content`, after saving a backup of every file it replaces outside the mod.

If the Mod Editor is open with the mod loaded, the backend reloads the published assets in place, so you see the result without restarting. Before you publish:

- stop Play In Editor;
- save or revert unsaved assets in the editor, because the backend refuses to publish over assets that have unsaved changes.

If a publish is refused, the message says why; the usual causes are in [troubleshooting.md](troubleshooting.md#publish-is-refused).

Then open the editor's content browser, find `Samples/BP_HelloAbfc`, and open the Blueprint. Its event graph shows `Bump` inside a comment box that says the unit is generated by abfc and that the `.ts` file is the source. Edit the TypeScript, not the nodes: abfc will not overwrite nodes you changed in the editor (it reports [ABFC5001](errors.md#abfc5001) instead), and a rebuild replaces what it generated.

Before you upload a mod to mod.io, run `abfc publish --full --dry-run` and then `abfc publish --full`, which also runs the game tests, the stage audit and the upload file check. abfc never uploads anything to mod.io; you do that yourself.

## Next steps

- [cli.md](cli.md): every command and option.
- [language-service.md](language-service.md): the VS Code extension and other editors.
- [lint-rules.md](lint-rules.md): the rules that catch tick cost and replication mistakes.
- [errors.md](errors.md): what each `ABFC` code means and how to fix it.
- [config.md](config.md): project and user settings.
