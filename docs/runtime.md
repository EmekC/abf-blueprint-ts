# Runtime API

`@abfc/runtime` holds the decorators, helper functions and types your TypeScript mod code imports. It has no runtime code: abfc reads the decorators and calls while compiling and turns them into Blueprint assets and nodes. Import what you use:

```ts
import { blueprint, event, cast, isValid } from "@abfc/runtime";
import type { int, float } from "@abfc/runtime";
```

Engine classes, functions and enums are not part of this package; they come from the generated stubs (`import { Actor } from "/Script/Engine"`, see [first-mod.md](first-mod.md)). Every engine function listed in the [node reference](https://emekc.github.io/abf-blueprint-ts/reference/nodes/) is used the same way.

## Decorators

### `@blueprint`

Turns a class into a Blueprint asset (the "New Blueprint Class" dialog, with its class defaults as options). The asset path comes from the file's folder below `src`; `kind: "widget"` makes a Widget Blueprint.

```ts
import { blueprint } from "@abfc/runtime";
import { Actor } from "/Script/Engine";

@blueprint({ replicates: true, tickInterval: 0.5 })
export class BP_Relay extends Actor {}
```

### `@struct`

Turns a class of plain fields into a mod-defined struct (the "Structure" asset in the content browser). Declare each field as `Name!: Type;`, with no methods and no initializers; use the class as a type, and an object literal becomes a Make Struct node.

```ts
import { struct } from "@abfc/runtime";
import type { int } from "@abfc/runtime";

@struct()
export class S_Entry {
  Id!: int;
  Label!: string;
}
```

### `@director`

Names the class-manager row of a Blueprint class, the row the game reads to start a director; the optional second argument is the gameplay tag the row holds. The build writes the row and, if needed, the tag.

```ts
import { blueprint, director } from "@abfc/runtime";
import { ActorComponent } from "/Script/Engine";

@director("MyDirector", ClassManager.EntityDirector.MyDirector)
@blueprint()
export class BPC_MyDirector extends ActorComponent {}
```

### `@event`

Turns a method into a custom event, the red "Add Custom Event" node of the event graph. Use it only for new events; an event the parent class already has needs `@override`.

```ts
@event
Bump(): void {
  this.Count = this.Count + 1;
}
```

### `@override`

Overrides an event or function the parent class already has, such as the Begin Play event of an actor. Write `override` before the method name as well.

```ts
@override
override ReceiveBeginPlay(): void {
  KismetSystemLibrary.PrintString("hi");
}
```

## Functions

### `createWidget`

The Create Widget node: makes a widget from a widget class for an owning player.

```ts
import { createWidget } from "@abfc/runtime";

// WBP_Hud is a widget class; OwnerPC is a player controller member of the class
const widget = createWidget(WBP_Hud, this.OwnerPC);
widget.AddToViewport();
```

### `spawnActor`

The Spawn Actor from Class node. The optional second argument takes `owner`, `instigator`, `collisionHandlingOverride` and `transformScaleMethod` as an object literal; the spawn transform is zero location and rotation with unit scale.

```ts
import { spawnActor } from "@abfc/runtime";

const relay = spawnActor(BP_Relay, { owner: this });
```

### `cast`

The Cast To node. It returns the object as the class you give, or `null` when it is not one; `if (x)`, `if (!x)` and `?.` on the result use the cast node's own success and failure pins.

```ts
import { cast } from "@abfc/runtime";

const pawn = cast(this.GetOwner(), Pawn);
if (pawn) {
  pawn.K2_DestroyActor();
}
```

### `isValid`

The Is Valid macro followed by a Branch. It narrows the type, so inside the `if` the value is not `null`.

```ts
import { isValid } from "@abfc/runtime";

if (isValid(this.Target)) {
  this.Target.K2_DestroyActor();
}
```

### `nameOf`

A Name literal: converts a string you write in the source into the `name` type that Blueprint pins of type Name expect.

```ts
import { nameOf } from "@abfc/runtime";

const socket = nameOf("hand_r");
```

### `idiv`

The integer division node (`Divide_IntInt`). The `/` operator on integers is error [ABFC2010](errors.md#abfc2010) because Blueprint division of integers truncates toward zero, so you say so with `idiv`.

```ts
import { idiv } from "@abfc/runtime";
import type { int } from "@abfc/runtime";

const half: int = idiv(this.Count, 2);
```

## Types

Numbers and strings are branded types: a literal fits any of them, but different kinds do not mix without a conversion.

| Type | Blueprint type |
| --- | --- |
| `int` | Integer |
| `int64` | Integer64 |
| `byte` | Byte |
| `float` | Float (real, single precision) |
| `double` | Float (real, double precision) |
| `name` | Name |
| `text` | Text; a template literal becomes a Format Text node |
| `TSubclassOf<T>` | Class reference to `T` or a child (Class pin) |
| `TSoftObjectPtr<T>` | Soft object reference to `T` |
| `TSoftClassPtr<T>` | Soft class reference to `T` |
| `GameplayTag` | A gameplay tag, such as the generated `ClassManager.EntityDirector.MyDirector` constants |
| `DelegateRef` | A delegate pin, filled with `this.<EventName>`, a reference to an `@event` method of the same class ([ABFC2054](errors.md#abfc2054) otherwise) |
