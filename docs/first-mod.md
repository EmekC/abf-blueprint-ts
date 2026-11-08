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

A field can also start with a value. A literal initializer (a number, `true` or `false`, a string or an enum value of the field's type) becomes the variable's default in the Blueprint:

```ts
Speed: float = 2.5;
```

Change the number and the next `abfc build` updates the default of the existing variable (with backend 2.6.0 or newer, [ABFC2084](errors.md#abfc2084) otherwise); take the initializer away (`Speed!: float;`) and the default is cleared.

### Calling engine functions: defaults

Engine functions keep the default values Unreal gives their parameters, so you only pass what you mean. These calls type-check and leave every other pin as the Blueprint editor would:

```ts
import { GameplayStatics, KismetSystemLibrary } from "/Script/Engine";

KismetSystemLibrary.PrintString("hi");   // duration, colour, log and screen flags keep their defaults
KismetSystemLibrary.Delay();             // Duration keeps 0.2
const player = GameplayStatics.GetPlayerCharacter();   // PlayerIndex is 0
```

Only a trailing run of parameters can be left out, as in TypeScript. Run `abfc stubs` once (and again after updating abfc) so the stubs carry the defaults.

### Text from values: template literals

A template literal becomes a Format Text node. Where a `string` is expected (such as `PrintString`) or in a `const` without a type annotation, abfc adds `To String (Text)` (`Conv_TextToString`) after it:

```ts
KismetSystemLibrary.PrintString(`Hello World From Typescript ${this.Count}`);
const line = `Score: ${this.Score}`;   // a string
```

Numbers are formatted the way Format Text formats them (culture rules, so large numbers can get grouping separators). A template literal cannot be a `name` ([ABFC2099](errors.md#abfc2099)).

### Overriding an engine event

To run code when the actor begins play, override the parent's event. `@override` is for events and functions the parent class already has; `@event` is only for new custom events (using `@event` on a name the parent has is [ABFC2078](errors.md#abfc2078)):

```ts
import { blueprint, override } from "@abfc/runtime";
import { Actor, KismetSystemLibrary } from "/Script/Engine";

@blueprint()
export class BP_Beacon extends Actor {
  @override
  override ReceiveBeginPlay(): void {
    KismetSystemLibrary.PrintString("hi");
  }
}
```

You do not have to remember the names: in VS Code, inside a class body, type `Rec` and pick `ReceiveBeginPlay` from the completion list; it writes the whole method and adds the missing imports. In the same way, typing `PrintS` inside a method offers `KismetSystemLibrary.PrintString` and adds its import. This needs the language server ([language-service.md](language-service.md)) and generated stubs.

### Functions: undecorated methods

A method without a decorator becomes a Blueprint function graph. Its parameters are the inputs and a non-void return type is the output `ReturnValue`; `private` and `protected` become the Blueprint access (the default is public). Call it as `this.name(...)` from events, overrides and other functions:

```ts
@override override ReceiveBeginPlay(): void {
  const t = this.runTest(5);
  this.Last = t;
}

private runTest(amount: int): int {
  this.Count = this.Count + amount;
  return this.Count;
}
```

In the Mod Editor the class gets a function graph `runTest` with an entry node, the nodes of the body and a result node, and a call node in the event graph. The graph belongs to the TypeScript: any change to the method recreates the whole graph (and applies the callers in the same class again), a renamed method creates the new graph and removes the old one, and edits made by hand inside the graph are replaced on the next build ([ABFC5014](errors.md#abfc5014)). Functions are impure (they have exec pins). A function needs a backend with the `function_graphs` feature ([ABFC2044](errors.md#abfc2044)).

Not supported: getters and setters, `static` methods, optional or default parameters ([ABFC2099](errors.md#abfc2099)), recursion ([ABFC2085](errors.md#abfc2085)), `await` or latent calls inside a function ([ABFC2086](errors.md#abfc2086)), and a method with the name of a parent member ([ABFC2087](errors.md#abfc2087)).

### Director with a gameplay tag

A director is a component (`ActorComponent`) that the game adds to its AI director when play begins, when its gameplay tag is present in the class manager. Name the row and the tag:

```ts
import { blueprint, director } from "@abfc/runtime";
import { ActorComponent } from "/Script/Engine";

@director("MyDirector", ClassManager.EntityDirector.MyDirector)
@blueprint()
export class BPC_MyDirector extends ActorComponent {}
```

To see it run, use Play In Editor (Play or Simulate) in the Mod Editor on its default map: during play the World Outliner lists `Abiotic_AIDirector` with your class among its components (for example `BPC_MyDirector_C_0`), next to the game's own directors. Another parent than ActorComponent is [ABFC2089](errors.md#abfc2089).

Typing `ClassManager.EntityDirector.` in your editor lists every tag the game and your mod know (they come from `abfc stubs`); a string such as `"ClassManager.EntityDirector.MyDirector"` works as well and autocompletes. A tag the mod does not have yet is created: the build adds it to the mod's tag list (`Config/Tags/ExampleModTags.ini`), `abfc publish` publishes the file, and an open Mod Editor is told about the new tag at publish (only when that fails, [ABFC7015](errors.md#abfc7015) asks you to restart it). Tags a build adds stay in the list even if you remove the director later, because the list is shared mod content. Without a tag the row starts nothing ([ABFC2079](errors.md#abfc2079)).

### Where the asset goes

You never write the asset path. It comes from the folder of the file below `src`: `src\Samples\BP_HelloAbfc.ts` builds `/ExampleMod/Samples/BP_HelloAbfc`, and a file `src\Relays\MyCustomRelay.ts` with `class MyCustomRelay` would build `/ExampleMod/Relays/MyCustomRelay`. A file directly in `src` gives `/ExampleMod/<ClassName>`. Folder and class names may use ASCII letters, digits and `_` only. Moving a file or renaming the class changes the path, and `abfc build` follows it: the existing Blueprint is renamed (`renamed <old> -> <new>`), references in your other Blueprints are fixed by Unreal, and `abfc publish` removes the old file from the mod. Changing `extends` works the same way (the asset is reparented, or created again when the new parent is of another kind), and deleting a class deletes its asset. Only a case that could mean several earlier assets stops with [ABFC5012](errors.md#abfc5012). All of this needs backend 2.6.0 (the one in `abfc.exe`); [cli.md](cli.md#abfc-build) lists the lines a build prints.

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

After a live reload abfc prints `route: live-reload`, the backup folder, and a note. The reload closes the asset editor tabs of the published assets and of the assets that reference them (reopen them to see the change), and it can leave some of those assets showing unsaved changes. Saving such an asset changes the mod outside abfc, so save only what you mean to.

If a publish is refused, the message says why; the usual causes are in [troubleshooting.md](troubleshooting.md#publish-is-refused).

Then open the editor's content browser, find `Samples/BP_HelloAbfc`, and open the Blueprint. Its event graph shows `Bump` inside a comment box that says the unit is generated by abfc and that the `.ts` file is the source. Edit the TypeScript, not the nodes. **TypeScript wins:** the next build that applies this class replaces what you changed in the editor in the generated nodes, and in a class without a hybrid part it removes the nodes, functions and variables you added by hand; one warning per asset ([ABFC5014](errors.md#abfc5014)) lists what went. `abfc status` previews it. To keep hand-made members (designer widgets, a hand-made event your TypeScript calls), put them in a class that merges with a `BP_HelloAbfc_Manual` interface (a hybrid class, see [design.md](design.md)); abfc then leaves them alone. Without that, make the change in the `.ts` file.

Before you upload a mod to mod.io, run `abfc publish --full --dry-run` and then `abfc publish --full`, which also runs the game tests, the stage audit and the upload file check. abfc never uploads anything to mod.io; you do that yourself.

## Next steps

- [cli.md](cli.md): every command and option.
- [language-service.md](language-service.md): the VS Code extension and other editors.
- [lint-rules.md](lint-rules.md): the rules that catch tick cost and replication mistakes.
- [errors.md](errors.md): what each `ABFC` code means and how to fix it.
- [config.md](config.md): project and user settings.
