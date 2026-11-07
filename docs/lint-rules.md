# Lint rules

`@abfc/eslint-plugin` flags code that compiles but is a performance or networking trap in Unreal. The rules are
warnings by default. `abfc check` does not run ESLint (it stays fast and its diagnostics stay the same as the
language service's); run ESLint with `npx eslint` or the ESLint editor extension.

## Setup

Install `eslint`, `@typescript-eslint/parser` and `@abfc/eslint-plugin`, then create `eslint.config.js`:

```js
import abfc from "@abfc/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ["src/**/*.ts"], ...abfc.configs.recommended },
];
```

`abfc.configs.recommended` registers the plugin as `abfc` and enables the five rules below as `"warn"`. The two
rules that read type information (`replicated-write-needs-authority`, `rpc-misuse`) report nothing when the file is
linted without a TypeScript project, so keep `parserOptions.projectService` (or `project`) set.

To change an option, enable the rule yourself after the recommended config:

```js
{ files: ["src/**/*.ts"], rules: { "abfc/no-heavy-call-in-tick": ["warn", { extra: ["MyScan"] }] } },
```

## Coverage limitation

The two networking rules use facts that the generated stubs carry as JSDoc tags: `@bpReplicated` on a replicated
variable, `@bpRpc server|client|multicast` and `@bpReliable` on a custom event. Those tags are written only for
members of the mod's own hand-made assets (read from the Blueprint's `PropertyFlags` and `FunctionFlags`). Members of
`/Script` and `/Game` classes have no replication or RPC flags in the reflection data, and TypeScript-owned
`@replicated` fields and RPC events do not exist yet, so none of them are covered. The rules never guess: a member
without a tag is treated as local, so the limitation hides findings but does not create false ones. Regenerate the
stubs with `abfc stubs` to pick the tags up.

## Tick context

A "tick" method is a method decorated `@override` whose name is in `tickMethods` (default `["ReceiveTick", "Tick"]`).
The check is lexical: code in a nested function or callback, and code in another event that a tick method calls, is
not treated as tick code.

## no-heavy-call-in-tick

Flags a call to an expensive world query or spawn inside a tick method: `GetAllActorsOfClass`,
`GetAllActorsOfClassWithTag`, `GetAllActorsWithTag`, `GetAllActorsWithInterface`, `GetActorOfClass`,
`GetAllWidgetsOfClass`, `GetAllWidgetsWithInterface`, `createWidget` and `spawnActor`. These walk the world or
allocate objects, and running them every frame costs frame time on every machine.

Options: `tickMethods: string[]` replaces the tick method names; `extra: string[]` adds more call names.

```ts
// bad
@override
ReceiveTick(dt: float): void {
  const doors = GetAllActorsOfClass(BP_ExampleDoor_C);
  // ...
}

// good: look the doors up once
@override
ReceiveBeginPlay(): void {
  this.Doors = GetAllActorsOfClass(BP_ExampleDoor_C);
}
```

## no-loop-in-tick

Flags `for`, `for...of`, `for...in`, `while` and `do...while` inside a tick method. A loop that is cheap today grows
with the number of actors; running it every frame turns that into a frame-rate problem.

Options: `tickMethods: string[]`.

```ts
// bad
@override
ReceiveTick(dt: float): void {
  for (const door of this.Doors) door.Refresh();
}

// good: do it from an event that a timer or a gameplay change triggers
@event
RefreshDoors(): void {
  for (const door of this.Doors) door.Refresh();
}
```

## replicated-write-needs-authority

Flags a write to a `@bpReplicated` variable that is not guarded by an authority check: `this.X = ...` (and compound
assignment or `++`), `this.X.push(...)`, `splice`, `pop`, `shift`, `unshift`, and `this.X.length = ...`. Only the
server may change a replicated value; a client write is overwritten by the next replication update and never reaches
other players. Writes in a constructor are ignored.

A write counts as guarded when it is inside the true branch of `if (this.HasAuthority())` (also through `&&`, `?:`
and `!` with the `else`), or an earlier statement of the same block is `if (!this.HasAuthority()) return;`.

Options: `authorityCalls: string[]` replaces the authority call names (default `HasAuthority`, `IsServer`,
`IsDedicatedServer`).

```ts
// bad
@event
AddPoint(): void {
  this.Score = this.Score + 1; // Score is replicated
}

// good
@event
AddPoint(): void {
  if (!this.HasAuthority()) return;
  this.Score = this.Score + 1;
}
```

## rpc-misuse

Two checks on calls of `@bpRpc` members:

- `clientFromClient`: a `client` or `multicast` RPC called without an authority guard. Only the server can send those;
  from a client the call goes nowhere.
- `reliableSpam`: a `@bpReliable` RPC called inside a tick method or inside a loop. Reliable messages are queued and
  resent until acknowledged, so sending them every frame overflows the reliable buffer and disconnects players.

Options: `authorityCalls: string[]` (as above) and `tickMethods: string[]`.

```ts
// bad
@event
Celebrate(): void {
  this.PlayFanfare(); // a reliable multicast RPC, called without authority
}

// good
@event
Celebrate(): void {
  if (this.HasAuthority()) this.PlayFanfare();
}
```

## no-unbounded-array-growth

Flags `this.A.push(...)` when nothing in the same class ever shrinks or bounds `A`. A list that only grows is a slow
memory leak in a long session. A class counts as bounding `A` when it contains `this.A.splice(`, `this.A.pop(`,
`this.A.shift(`, `this.A.length = ...` or `this.A = ...`, or when the push sits inside an `if`, conditional,
`while` or `for` whose condition mentions `this.A.length`, `this.A.includes(` or `this.A.indexOf(`. The rule is
syntactic: it does not follow the array through other objects or helper functions.

Options: `ignore: string[]` lists array names that are allowed to grow.

```ts
// bad
@event
Remember(name: name): void {
  this.Seen.push(name);
}

// good
@event
Remember(name: name): void {
  if (!this.Seen.includes(name)) this.Seen.push(name);
}
```
