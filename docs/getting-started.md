# Getting started

This page is the shortest path from nothing to a Blueprint written in TypeScript and published into your mod. Each step names the page with the details.

## 1. What you need

- Windows 10 or 11, 64-bit.
- The Abiotic Factor Mod Editor, installed from the Epic Games Launcher.
- A mod created and saved in the Mod Editor, with a name made of letters, digits and underscores (this page calls it `ExampleMod`). abfc builds into an existing mod; it never creates one ([first-mod.md](first-mod.md#1-create-the-mod-in-the-mod-editor)).

Nothing else: `abfc.exe` carries its own Node runtime, its own Python and the Mod Editor backend.

## 2. Install abfc

Download `abfc-setup-<version>.exe` from the [releases page](https://github.com/EmekC/abf-blueprint-ts/releases) (the newest release that is not marked as a pre-release) and run it. Windows will probably warn about an unknown publisher; click **More info**, then **Run anyway** ([install.md](install.md#smartscreen)). Keep the default task that adds abfc to your `PATH`.

Open a new terminal and check the install:

```
abfc --version
abfc doctor
```

`abfc doctor` prints a checklist of what abfc found (the Mod Editor, the mods folder, the backend). See [install.md](install.md#installer) for the details and [troubleshooting.md](troubleshooting.md) if something is missing.

## 3. Make a project and run `abfc init`

The TypeScript project lives in its own folder, outside the mods folder and outside the mod. Keep the path short:

```
mkdir C:\abfc\ExampleMod
cd C:\abfc\ExampleMod
abfc init
```

`abfc init` lists the mods it finds and asks which one to link; choose yours and answer `y` to write the files. To skip the questions, name the mod:

```
abfc init --mod ExampleMod --yes
```

## 4. What `init` already did

`abfc init` writes the project files and the sample class, then runs `abfc generate` and `abfc doctor` for you ([cli.md](cli.md#abfc-init)). `abfc generate` writes the stubs, the `.d.ts` files that describe the engine and your mod's assets to TypeScript.

- The first generate takes about 3-4 minutes and needs the network once ([troubleshooting.md](troubleshooting.md#the-first-abfc-generate-needs-the-network)). Later runs reuse the cache.
- Run `abfc generate` again after you update abfc, and use `abfc generate --add <path>` when you need an engine name the stubs do not have yet ([cli.md](cli.md#abfc-generate)).

## 5. The sample class and one engine call

`src\Samples\BP_HelloAbfc.ts` is an Actor Blueprint with an integer variable and one custom event. Open the folder in VS Code and add one engine call to the event:

```ts
import { blueprint, event } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor, KismetSystemLibrary } from "/Script/Engine";

@blueprint()
export class BP_HelloAbfc extends Actor {
  Count!: int;

  /** Adds one to Count and prints a message. */
  @event
  Bump(): void {
    this.Count = this.Count + 1;
    KismetSystemLibrary.PrintString("hi");
  }
}
```

`@blueprint()` makes the class a Blueprint asset, `@event` makes `Bump` a custom event, and `KismetSystemLibrary.PrintString("hi")` is the Print String node. Parameters you leave out keep the defaults Unreal gives them. The asset path comes from the file: this file builds `/ExampleMod/Samples/BP_HelloAbfc`.

## 6. Build and publish

```
abfc build
abfc publish --dry-run
abfc publish
```

`abfc build` turns the class into Blueprint graphs in a private staging copy of the mod and compiles them in Unreal; your mod is not changed yet, and the first build takes longer. `abfc publish --dry-run` lists the assets `abfc publish` would copy, and `abfc publish` copies them into `<mods folder>\ExampleMod\Content` after saving a backup of every file it replaces. Stop Play In Editor and save or revert unsaved assets in the Mod Editor first ([first-mod.md](first-mod.md#6-publish)).

Then open the content browser in the Mod Editor, find `Samples/BP_HelloAbfc` and open it. Edit the TypeScript from now on, not the nodes: the next build replaces what you changed by hand in the generated nodes.

## 7. Next steps

- [first-mod.md](first-mod.md): the same path in detail, with defaults, template literals, overrides, functions and directors.
- [Node reference](https://emekc.github.io/abf-blueprint-ts/reference/nodes/): the engine functions with a documented Blueprint node, and their TypeScript names.
- [errors.md](errors.md): what each `ABFC` code means and how to fix it.
- [install.md](install.md#vs-code-extension): the VS Code extension, for completion, hover and diagnostics.
