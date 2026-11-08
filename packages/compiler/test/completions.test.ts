import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCompletionIndex, buildLibraryIndex, completionsAt, displayNameFromDoc, libraryEntriesOf, loadProgram, matchName } from "../src/index.js";
import type { AbfcCompletion, CompletionIndex, LibraryEntry } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase4Dir = fileURLToPath(new URL("../../test/fixtures/phase4", import.meta.url));

const ENGINE_EXTRA = `
/**
 * @bpPath /Script/FakeEngine.KismetSystemLibrary
 * @bpMeta /Script/CoreUObject.Class
 */
export declare namespace KismetSystemLibrary {
  /**
   * Prints a string to the screen and the log.
   * @bpPath /Script/FakeEngine.KismetSystemLibrary:PrintString
   * @bpParam InString string
   * @bpDefault InString "Hello"
   */
  function PrintString(InString?: string): void;
  /**
   * @bpPath /Script/FakeEngine.KismetSystemLibrary:PrintText
   * @bpParam InText string
   */
  function PrintText(InText: string): void;
  /**
   * @bpPath /Script/FakeEngine.KismetSystemLibrary:PrintOld
   * @deprecated use PrintString
   */
  function PrintOld(): void;
  /**
   * Starts a timer that runs the given event after a delay (Set Timer by Event).
   * @bpPath /Script/FakeEngine.KismetSystemLibrary:K2_SetTimerDelegate
   * @bpParam Time double
   * @bpParam bLooping bool
   */
  function K2_SetTimerDelegate(Time: double, bLooping: boolean): void;
  /**
   * Tells whether the array holds the item (Contains Item).
   * @bpPath /Script/FakeEngine.KismetSystemLibrary:Array_Contains
   */
  function Array_Contains(): boolean;
}
`;

const MOD_LIB = `import type { int } from "@abfc/runtime";

/**
 * @bpPath /TestMod/Lib/ModLib.ModLib_C
 * @bpMeta /Script/CoreUObject.Class
 */
export declare namespace ModLib {
  /**
   * Frobs the thing.
   * @bpPath /TestMod/Lib/ModLib.ModLib_C:FrobThing
   * @bpParam Count int
   */
  function FrobThing(Count: int): void;
}
`;

const EXTRA_EVENTS = `  /**
   * @bpPath /Script/FakeEngine.Actor:ReceiveHit
   * @bpParam Other object:/Script/CoreUObject.Object
   */
  ReceiveHit(Other: UObject): void;
  /**
   * Event fired when something happens.
   * @bpPath /Script/FakeEngine.Actor:HappenedSomething
   */
  HappenedSomething(): void;
  /**
   * @bpPath /Script/FakeEngine.Actor:ReceiveOld
   * @deprecated use something else
   */
  ReceiveOld(): void;
  /**
   * @bpPath /Script/FakeEngine.Actor:ReceiveValue
   * @bpPure
   */
  ReceiveValue(): void;
  /**
   * @bpPath /Script/FakeEngine.Actor:ReceiveCount
   */
  ReceiveCount(): int;
  /**
   * Event called when the actor is constructed.
   * @bpPath /Script/FakeEngine.Actor:UserConstructionScript
   */
  UserConstructionScript(): void;
  /**
   * Returns the name of the current level (Get Current Level Name).
   * @bpPath /Script/FakeEngine.Actor:K2_GetLevelName
   */
  K2_GetLevelName(): string;
`;

/** phase4 plus a library namespace (engine and mod), a lock file and some more Actor members; fn gets the project and its stubs profile dir. */
function withProject<T>(fn: (dir: string, profile: string) => T): T {
  const dir = mkdtempSync(join(here, "completions-"));
  try {
    cpSync(phase4Dir, dir, { recursive: true });
    const profile = join(dir, ".abfc", "stubs", "test");
    const engineFile = join(profile, "Script", "FakeEngine.d.ts");
    let engine = readFileSync(engineFile, "utf8");
    assert.ok(engine.includes("  K2_DestroyActor(): void;\n"));
    engine = engine.replace("  K2_DestroyActor(): void;\n", `  K2_DestroyActor(): void;\n${EXTRA_EVENTS}`);
    engine = engine.replace('import type { EnumText, double } from "@abfc/runtime";', 'import type { EnumText, double, int } from "@abfc/runtime";');
    writeFileSync(engineFile, engine + ENGINE_EXTRA, "utf8");
    mkdirSync(join(profile, "Mod", "TestMod", "Lib"), { recursive: true });
    writeFileSync(join(profile, "Mod", "TestMod", "Lib", "ModLib.d.ts"), MOD_LIB, "utf8");
    writeFileSync(join(profile, "stubs.lock.json"), "{}\n", "utf8");
    return fn(dir, profile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Completions at the `|` marker of `source` (the marker is removed from the file). */
function at(dir: string, profile: string, source: string): { items: AbfcCompletion[]; text: string; pos: number } {
  const pos = source.indexOf("|");
  assert.ok(pos >= 0, "marker");
  const text = source.slice(0, pos) + source.slice(pos + 1);
  const file = join(dir, "src", "Comp.ts");
  writeFileSync(file, text, "utf8");
  const loaded = loadProgram(dir);
  const index = buildLibraryIndex(profile);
  return { items: completionsAt(loaded, file, pos, index), text, pos };
}

/** The file text after accepting a completion (the replaced word and the additional edits). */
function accept(text: string, c: AbfcCompletion): string {
  const edits = [{ start: c.replace.start, end: c.replace.end, newText: c.insertText }, ...c.additionalEdits];
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

const labels = (items: AbfcCompletion[]): string[] => items.map((i) => i.label);

const HEAD = `import { blueprint, event, override } from "@abfc/runtime";\nimport type { int } from "@abfc/runtime";\nimport { Actor } from "/Script/FakeEngine";\n\n`;

test("buildLibraryIndex lists static functions with module, signature and doc, skips deprecated, and caches by the lock mtime", () => {
  withProject((_dir, profile) => {
    const index = buildLibraryIndex(profile);
    const print = index.find((e) => e.name === "PrintString");
    assert.deepEqual(print, {
      name: "PrintString",
      container: "KismetSystemLibrary",
      module: "/Script/FakeEngine",
      signature: "(InString?: string): void",
      doc: "Prints a string to the screen and the log.",
    } satisfies LibraryEntry);
    assert.equal(index.some((e) => e.name === "PrintOld"), false, "deprecated functions are left out");
    const frob = index.find((e) => e.name === "FrobThing");
    assert.equal(frob?.module, "@mod/Lib/ModLib");
    assert.equal(frob?.container, "ModLib");
    assert.equal(frob?.signature, "(Count: int): void");

    assert.equal(buildLibraryIndex(profile), index, "same lock mtime: cached");
    const lock = join(profile, "stubs.lock.json");
    const later = new Date(Date.now() + 60_000);
    utimesSync(lock, later, later);
    const again = buildLibraryIndex(profile);
    assert.notEqual(again, index, "a new lock mtime rebuilds");
    assert.deepEqual(again, index);
  });
});

test("a library function name in a method body inserts Container.Name and extends the import of its module", () => {
  withProject((dir, profile) => {
    const source = `${HEAD}@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  @event\n  Go(): void {\n    PrintS|\n  }\n}\n`;
    const { items, text } = at(dir, profile, source);
    const print = items.find((i) => i.label === "PrintString");
    assert.ok(print, labels(items).join());
    assert.equal(print.kind, "function");
    assert.equal(print.snippet, false);
    assert.equal(print.detail, "KismetSystemLibrary.PrintString(InString?: string): void");
    assert.equal(print.documentation, "Prints a string to the screen and the log.");
    assert.equal(print.insertText, "KismetSystemLibrary.PrintString");
    assert.equal(print.additionalEdits.length, 1);
    assert.equal(accept(text, print), text.replace('import { Actor } from "/Script/FakeEngine";', 'import { Actor, KismetSystemLibrary } from "/Script/FakeEngine";').replace("PrintS\n", "KismetSystemLibrary.PrintString\n"));
    assert.equal(items.some((i) => i.label === "PrintOld"), false);
    assert.equal(items.some((i) => i.label === "PrintText"), false, "only functions with the typed prefix");
    const lower = at(dir, profile, source.replace("PrintS|", "print|"));
    assert.deepEqual(labels(lower.items), ["PrintString", "PrintText"], "case-insensitive");
  });
});

test("a library whose module is not imported gets a new import line after the last import", () => {
  withProject((dir, profile) => {
    const source = `${HEAD}@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  @event\n  Go(): void {\n    Frob|\n  }\n}\n`;
    const { items, text } = at(dir, profile, source);
    const frob = items.find((i) => i.label === "FrobThing");
    assert.ok(frob);
    assert.equal(frob.insertText, "ModLib.FrobThing");
    assert.equal(
      accept(text, frob),
      text.replace('import { Actor } from "/Script/FakeEngine";\n', 'import { Actor } from "/Script/FakeEngine";\nimport { ModLib } from "@mod/Lib/ModLib";\n').replace("Frob\n", "ModLib.FrobThing\n"),
    );

    // no import at all: the line goes in front of the first statement
    const bare = at(dir, profile, `export function go(): void {\n  PrintS|\n}\n`);
    const p = bare.items.find((i) => i.label === "PrintString");
    assert.ok(p);
    assert.equal(accept(bare.text, p), `import { KismetSystemLibrary } from "/Script/FakeEngine";\nexport function go(): void {\n  KismetSystemLibrary.PrintString\n}\n`);

    // the first statement is the completed word: the import is folded into the inserted text
    const top = at(dir, profile, `PrintS|\n`);
    const t = top.items.find((i) => i.label === "PrintString");
    assert.ok(t);
    assert.equal(t.additionalEdits.length, 0);
    assert.equal(accept(top.text, t), `import { KismetSystemLibrary } from "/Script/FakeEngine";\nKismetSystemLibrary.PrintString\n`);
  });
});

test("an existing import is reused (also under an alias) and a name bound to something else suppresses the item", () => {
  withProject((dir, profile) => {
    const body = `\nexport function go(): void {\n  PrintS|\n}\n`;
    const aliased = at(dir, profile, `import { KismetSystemLibrary as K } from "/Script/FakeEngine";${body}`);
    const a = aliased.items.find((i) => i.label === "PrintString");
    assert.ok(a);
    assert.equal(a.insertText, "K.PrintString");
    assert.equal(a.additionalEdits.length, 0);

    const shadowed = at(dir, profile, `const KismetSystemLibrary = 3;\nexport function go(): void {\n  PrintS|\n}\n`);
    assert.deepEqual(labels(shadowed.items), [], "Container is bound to something else");

    const typeOnly = at(dir, profile, `import type { KismetSystemLibrary } from "/Script/FakeEngine";${body}`);
    assert.deepEqual(labels(typeOnly.items), [], "a type-only import cannot be called");
  });
});

test("no library items in comments, strings, imports, after a dot, in types, decorators or declaration names", () => {
  withProject((dir, profile) => {
    const wrap = (code: string): string => `${HEAD}@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  @event\n  Go(): void {\n    ${code}\n  }\n}\n`;
    const cases: Record<string, string> = {
      "line comment": wrap("// PrintS|"),
      "line comment after code": wrap("this.K2_DestroyActor(); // PrintS|"),
      "block comment": wrap("/* PrintS| */"),
      "doc comment": `${HEAD}/** PrintS| */\nexport function f(): void {}\n`,
      "end of file comment": `${HEAD}// PrintS|`,
      "string": wrap('const s = "PrintS|";'),
      "unterminated string": wrap('const s = "PrintS|'),
      "template text": wrap("const s = `a PrintS| b`;"),
      "after dot": wrap("this.PrintS|"),
      "after optional chain": wrap("this?.PrintS|"),
      "import": `import { PrintS| } from "/Script/FakeEngine";\n`,
      "import path": `import { Actor } from "/Script/Print|";\n`,
      "type annotation": wrap("let v: PrintS|;"),
      "variable name": wrap("const PrintS| = 1;"),
      "parameter name": `${HEAD}export function f(PrintS|): void {}\n`,
      "decorator": `${HEAD}@Print|\nexport class X {}\n`,
      "after at": `${HEAD}@PrintS|\nexport class X {}\n`,
      "extends": `${HEAD}export class X extends PrintS| {}\n`,
      "no prefix": wrap("|"),
      "number": wrap("const n = 12|;"),
    };
    for (const [name, source] of Object.entries(cases)) {
      const { items } = at(dir, profile, source);
      assert.deepEqual(labels(items), [], name);
    }
    // sanity: the same code outside those contexts does offer it
    assert.ok(labels(at(dir, profile, wrap("const s = `${PrintS|}`;")).items).includes("PrintString"), "inside a template substitution");
    assert.ok(labels(at(dir, profile, wrap("const s = [...PrintS|];")).items).includes("PrintString"), "after a spread");
  });
});

test("Rec in a class body offers the overridable parent events as @override stubs with the imports they need", () => {
  withProject((dir, profile) => {
    const source = `import { blueprint, event } from "@abfc/runtime";\nimport type { int } from "@abfc/runtime";\nimport { Actor } from "/Script/FakeEngine";\n\n@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  Score!: int;\n\n  Rec|\n}\n`;
    const { items, text } = at(dir, profile, source);
    assert.deepEqual(labels(items), ["ReceiveBeginPlay", "ReceiveHit", "ReceiveTick"], "Rec matches; not pure, deprecated or value-returning ones");
    const tick = items.find((i) => i.label === "ReceiveTick");
    assert.ok(tick);
    assert.equal(tick.kind, "method");
    assert.equal(tick.snippet, true);
    assert.equal(tick.insertText, "@override override ReceiveTick(DeltaSeconds: double): void {\n\t$0\n}");
    assert.equal(tick.detail, "override ReceiveTick(DeltaSeconds: double): void");
    assert.equal(
      accept(text, tick),
      text
        .replace('import { blueprint, event } from "@abfc/runtime";\nimport type { int } from "@abfc/runtime";', 'import { blueprint, event, override } from "@abfc/runtime";\nimport type { int, double } from "@abfc/runtime";')
        .replace("  Rec\n", "  @override override ReceiveTick(DeltaSeconds: double): void {\n\t$0\n}\n"),
    );

    const begin = items.find((i) => i.label === "ReceiveBeginPlay");
    assert.ok(begin);
    assert.equal(begin.insertText, "@override override ReceiveBeginPlay(): void {\n\t$0\n}");

    // a type from another module becomes a type import line after the last import
    const hit = items.find((i) => i.label === "ReceiveHit");
    assert.ok(hit);
    assert.equal(hit.insertText, "@override override ReceiveHit(Other: UObject): void {\n\t$0\n}");
    assert.equal(accept(text, hit).split("\n")[3], 'import type { UObject } from "/Script/CoreUObject";');
    assert.ok(accept(text, hit).includes(", override }"), "override joins the runtime value import");
  });
});

test("override stubs add a new runtime import and type import when the file has none, and use the local alias of override", () => {
  withProject((dir, profile) => {
    const bare = at(dir, profile, `import { Actor } from "/Script/FakeEngine";\nexport class A extends Actor {\n  ReceiveT|\n}\n`);
    const tick = bare.items.find((i) => i.label === "ReceiveTick");
    assert.ok(tick);
    assert.equal(
      accept(bare.text, tick),
      `import { override } from "@abfc/runtime";\nimport { Actor } from "/Script/FakeEngine";\nimport type { double } from "@abfc/runtime";\nexport class A extends Actor {\n  @override override ReceiveTick(DeltaSeconds: double): void {\n\t$0\n}\n}\n`,
    );

    const aliased = at(dir, profile, `import { override as ov } from "@abfc/runtime";\nimport type { double } from "@abfc/runtime";\nimport { Actor } from "/Script/FakeEngine";\nexport class A extends Actor {\n  ReceiveT|\n}\n`);
    const t2 = aliased.items.find((i) => i.label === "ReceiveTick");
    assert.ok(t2);
    assert.equal(t2.insertText, "@ov override ReceiveTick(DeltaSeconds: double): void {\n\t$0\n}");
    assert.equal(t2.additionalEdits.length, 0, "everything is imported already");
  });
});

test("events already declared in the class, non-events and events by documentation", () => {
  withProject((dir, profile) => {
    const declared = at(
      dir,
      profile,
      `${HEAD}export class A extends Actor {\n  @override\n  override ReceiveBeginPlay(): void {}\n\n  Rec|\n}\n`,
    );
    assert.deepEqual(labels(declared.items), ["ReceiveHit", "ReceiveTick"], "an already declared override is not offered");

    const nonEvent = at(dir, profile, `${HEAD}export class A extends Actor {\n  K2_Dest|\n}\n`);
    assert.deepEqual(labels(nonEvent.items), [], "K2_DestroyActor is not an event");

    const byDoc = at(dir, profile, `${HEAD}export class A extends Actor {\n  Happ|\n}\n`);
    assert.deepEqual(labels(byDoc.items), ["HappenedSomething"], "a doc line starting with Event");
    assert.equal(byDoc.items[0]?.documentation, "Event fired when something happens.");

    const middle = at(dir, profile, `${HEAD}export class A extends Actor {\n  BeginPl|\n}\n`);
    assert.deepEqual(labels(middle.items), ["ReceiveBeginPlay"], "any part of the name");
  });
});

test("override stubs only at a member start of a class with a stub parent", () => {
  withProject((dir, profile) => {
    const decorated = `${HEAD}export class A extends Actor {\n  @override\n  Rec|\n}\n`;
    assert.deepEqual(labels(at(dir, profile, decorated).items), [], "after a decorator the stub would repeat it");

    const typed = `${HEAD}export class A extends Actor {\n  Score: Rec|\n}\n`;
    assert.deepEqual(labels(at(dir, profile, typed).items), [], "type position");

    const initializer = `${HEAD}export class A extends Actor {\n  Score = Rec|\n}\n`;
    assert.deepEqual(labels(at(dir, profile, initializer).items), [], "an initializer is an expression, not a member");

    const noParent = `${HEAD}export class A {\n  Rec|\n}\n`;
    assert.deepEqual(labels(at(dir, profile, noParent).items), [], "no parent class");

    const inBody = `${HEAD}export class A extends Actor {\n  M(): void {\n    Rec|\n  }\n}\n`;
    assert.deepEqual(labels(at(dir, profile, inBody).items), [], "a method body offers libraries, not overrides");

    const afterDot = `${HEAD}export class A extends Actor {\n  M(): void {\n    this.Rec|\n  }\n}\n`;
    assert.deepEqual(labels(at(dir, profile, afterDot).items), []);

    const comment = `${HEAD}export class A extends Actor {\n  // Rec|\n}\n`;
    assert.deepEqual(labels(at(dir, profile, comment).items), []);

    // an explicit invocation on an empty line in the class body lists the events
    const empty = at(dir, profile, `${HEAD}export class A extends Actor {\n  Score!: int;\n  |\n}\n`);
    assert.deepEqual(labels(empty.items), ["HappenedSomething", "ReceiveBeginPlay", "ReceiveHit", "ReceiveTick"], "UserConstructionScript (ABFC2083) is never offered");
    const openBrace = at(dir, profile, `${HEAD}export class A extends Actor {|}\n`);
    assert.equal(openBrace.items.length, 4);
    const between = at(dir, profile, `${HEAD}export class A extends Actor {\n  Score!: int;\n  |\n  Other!: int;\n}\n`);
    assert.equal(between.items.length, 4);
  });
});

test("displayNameFromDoc reads the trailing node name, nested parentheses included", () => {
  assert.equal(displayNameFromDoc("Starts a timer (Set Timer by Event)."), "Set Timer by Event");
  assert.equal(displayNameFromDoc("Converts (To Float (Integer))."), "To Float (Integer)");
  assert.equal(displayNameFromDoc("Prints a string."), undefined);
  assert.equal(displayNameFromDoc(""), undefined);
  assert.equal(displayNameFromDoc("Bad (x."), undefined);
});

test("matchName tiers: full prefix, K2_-stripped, display prefix, word start, minimum length", () => {
  const timer = "K2_SetTimerDelegate";
  const display = "Set Timer by Event";
  assert.deepEqual(matchName(timer, display, "K2_Set"), { tier: 0, filterText: timer });
  assert.deepEqual(matchName(timer, display, "settimer"), { tier: 1, filterText: "SetTimerDelegate" });
  assert.deepEqual(matchName(timer, display, "settimerbyev"), { tier: 2, filterText: "SetTimerbyEvent" });
  assert.deepEqual(matchName(timer, display, "timer"), { tier: 3, filterText: "TimerDelegate" });
  assert.deepEqual(matchName(timer, display, "byevent"), { tier: 3, filterText: "byEvent" });
  assert.equal(matchName(timer, display, "ti"), undefined);
  assert.deepEqual(matchName("Array_Contains", "Contains Item", "containsit"), { tier: 2, filterText: "ContainsItem" });
  assert.deepEqual(matchName("Array_Contains", undefined, "contains"), { tier: 3, filterText: "Contains" });
  assert.deepEqual(matchName("GetHUDClass", undefined, "class"), { tier: 3, filterText: "Class" });
  assert.equal(matchName("GetHUDClass", undefined, "udc"), undefined);
});

test("buildLibraryIndex reads the display name from the description", () => {
  withProject((_dir, profile) => {
    const index = buildLibraryIndex(profile);
    const timer = index.find((e) => e.name === "K2_SetTimerDelegate");
    assert.equal(timer?.displayName, "Set Timer by Event");
    const print = index.find((e) => e.name === "PrintString");
    assert.ok(print);
    assert.equal("displayName" in print, false);
  });
});

test("settimer, timer and the display name find K2_SetTimerDelegate qualified with its import", () => {
  withProject((dir, profile) => {
    const wrap = (code: string): string => `${HEAD}@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  @event\n  Go(): void {\n    ${code}\n  }\n}\n`;
    const cases: Array<[string, string]> = [
      ["settimer", "SetTimerDelegate"],
      ["timer", "TimerDelegate"],
      ["timerdelegate", "TimerDelegate"],
      ["settimerdelegate", "SetTimerDelegate"],
      ["SetTimerByEv", "SetTimerbyEvent"],
    ];
    for (const [typed, filterText] of cases) {
      const { items, text } = at(dir, profile, wrap(`${typed}|`));
      const item = items.find((i) => i.label === "K2_SetTimerDelegate");
      assert.ok(item, `${typed}: ${labels(items).join()}`);
      assert.equal(item.insertText, "KismetSystemLibrary.K2_SetTimerDelegate", typed);
      assert.equal(item.filterText, filterText, typed);
      assert.equal(item.labelDescription, "KismetSystemLibrary · Set Timer by Event", typed);
      assert.equal(
        accept(text, item),
        text.replace('import { Actor } from "/Script/FakeEngine";', 'import { Actor, KismetSystemLibrary } from "/Script/FakeEngine";').replace(`${typed}\n`, "KismetSystemLibrary.K2_SetTimerDelegate\n"),
        typed,
      );
    }
  });
});

test("ranking: full-name prefixes before stripped, display and word-start matches; short prefixes only match prefixes", () => {
  withProject((dir, profile) => {
    const wrap = (code: string): string => `${HEAD}@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  @event\n  Go(): void {\n    ${code}\n  }\n}\n`;
    const print = at(dir, profile, wrap("Print|")).items.find((i) => i.label === "PrintString");
    assert.equal(print?.sortText, "1APrintString");

    const con = at(dir, profile, wrap("con|")).items;
    const contains = con.find((i) => i.label === "Array_Contains");
    assert.ok(contains, labels(con).join());
    assert.equal(contains.sortText, "1CArray_Contains");
    const at2 = con.indexOf(contains);
    for (const [i, item] of con.entries()) {
      if (item.sortText.startsWith("1A") || item.sortText.startsWith("1B")) assert.ok(i < at2, `${item.label} ranks before the display-name match`);
    }

    const timer = at(dir, profile, wrap("timer|")).items.find((i) => i.label === "K2_SetTimerDelegate");
    assert.equal(timer?.sortText, "1DK2_SetTimerDelegate");

    const co = at(dir, profile, wrap("co|")).items;
    assert.equal(co.some((i) => i.label === "Array_Contains"), false, "two typed characters match prefixes only");
  });
});

test("after a dot only display-name matches the C++ name misses", () => {
  withProject((dir, profile) => {
    const wrap = (code: string, head: string = HEAD): string => `${head}@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  @event\n  Go(): void {\n    ${code}\n  }\n}\n`;
    const level = at(dir, profile, wrap("this.getcurrent|")).items;
    assert.deepEqual(labels(level), ["K2_GetLevelName"]);
    const item = level[0];
    assert.ok(item);
    assert.equal(item.insertText, "K2_GetLevelName");
    assert.deepEqual(item.additionalEdits, []);
    assert.equal(item.kind, "method");
    assert.equal(item.filterText, "GetCurrentLevelName");

    assert.equal(labels(at(dir, profile, wrap("this.getlev|")).items).includes("K2_GetLevelName"), false, "the C++ name matches: tsserver covers it");
    assert.deepEqual(at(dir, profile, wrap("this.ge|")).items, []);
    assert.deepEqual(labels(at(dir, profile, wrap("this?.getcurrent|")).items), ["K2_GetLevelName"]);

    const head = `${HEAD}import { KismetSystemLibrary } from "/Script/FakeEngine";\n`;
    const lib = at(dir, profile, wrap("KismetSystemLibrary.settimerbyev|", head)).items.find((i) => i.label === "K2_SetTimerDelegate");
    assert.ok(lib);
    assert.equal(lib.insertText, "K2_SetTimerDelegate");
    assert.equal(lib.kind, "function");
    assert.equal(at(dir, profile, wrap("KismetSystemLibrary.settimer|", head)).items.some((i) => i.label === "K2_SetTimerDelegate"), false, "tsserver covers it");
  });
});

test("the library index is capped at 100 items", () => {
  withProject((dir, profile) => {
    const many: LibraryEntry[] = [];
    for (let i = 0; i < 150; i++) many.push({ name: `Spam${String(i).padStart(3, "0")}`, container: "SpamLibrary", module: "/Script/Spam", signature: "(): void", doc: "" });
    const file = join(dir, "src", "Comp.ts");
    const source = "export function go(): void {\n  Spa\n}\n";
    writeFileSync(file, source, "utf8");
    const loaded = loadProgram(dir);
    const items = completionsAt(loaded, file, source.indexOf("Spa\n") + 3, many);
    assert.equal(items.length, 100);
    assert.equal(items[0]?.label, "Spam000");
    assert.equal(items[0]?.additionalEdits.length, 1);
    void profile;
  });
});

// ---- catalog names: classes, structs and enums with their import; catalog-only functions; the prebuilt library file ----

const NAMES = {
  version: 1,
  types: [
    { name: "BP_Fake_C", module: "/Game/Fake/BP_Fake", path: "/Game/Fake/BP_Fake.BP_Fake_C", kind: "class" },
    { name: "FakeActor", module: "/Script/FakeEngine", path: "/Script/FakeEngine.FakeActor", kind: "class" },
    { name: "FakeVec", module: "/Script/FakeEngine", path: "/Script/FakeEngine.FakeVec", kind: "struct" },
    { name: "FakeMode", module: "/Script/FakeEngine", path: "/Script/FakeEngine.FakeMode", kind: "enum" },
  ],
  functions: [
    { name: "PrintAlpha", container: "SpareLibrary", module: "/Script/FakeSpare" },
    { name: "PrintString", container: "KismetSystemLibrary", module: "/Script/FakeEngine" },
  ],
};

/** Completions at the `|` marker of `source` with a ready completion index. */
function atWith(dir: string, source: string, index: CompletionIndex): { items: AbfcCompletion[]; text: string } {
  const pos = source.indexOf("|");
  assert.ok(pos >= 0, "marker");
  const text = source.slice(0, pos) + source.slice(pos + 1);
  const file = join(dir, "src", "Comp.ts");
  writeFileSync(file, text, "utf8");
  return { items: completionsAt(loadProgram(dir), file, pos, index), text };
}

function withNames<T>(fn: (dir: string, index: CompletionIndex) => T, names: unknown = NAMES): T {
  return withProject((dir, profile) => {
    writeFileSync(join(profile, "_names.json"), JSON.stringify(names), "utf8");
    return fn(dir, buildCompletionIndex(profile));
  });
}

test("a catalog class in a type annotation brings its value import; a struct a type import; an enum too", () => {
  withNames((dir, index) => {
    const cls = atWith(dir, `export function go(): void {\n  let v: BP_Fa|;\n}\n`, index);
    assert.deepEqual(labels(cls.items), ["BP_Fake_C"]);
    const c = cls.items[0] as AbfcCompletion;
    assert.equal(c.kind, "class");
    assert.equal(c.detail, "/Game/Fake/BP_Fake.BP_Fake_C");
    assert.equal(c.labelDescription, "/Game/Fake/BP_Fake");
    assert.equal(c.insertText, "BP_Fake_C");
    assert.equal(accept(cls.text, c), `import { BP_Fake_C } from "/Game/Fake/BP_Fake";\nexport function go(): void {\n  let v: BP_Fake_C;\n}\n`);

    const head = `import { Actor } from "/Script/FakeEngine";\n`;
    const all = atWith(dir, `${head}export function go(): void {\n  let v: Fake|;\n}\n`, index);
    assert.deepEqual(labels(all.items), ["FakeActor", "FakeMode", "FakeVec", "BP_Fake_C"], "BP_Fake_C matches by word start");
    assert.deepEqual(all.items.map((i) => i.kind), ["class", "enum", "struct", "class"]);
    const vec = all.items.find((i) => i.label === "FakeVec") as AbfcCompletion;
    assert.equal(accept(all.text, vec), `${head}import type { FakeVec } from "/Script/FakeEngine";\nexport function go(): void {\n  let v: FakeVec;\n}\n`);
    const mode = all.items.find((i) => i.label === "FakeMode") as AbfcCompletion;
    assert.ok(accept(all.text, mode).includes(`import type { FakeMode } from "/Script/FakeEngine";`));
    const actor = all.items.find((i) => i.label === "FakeActor") as AbfcCompletion;
    assert.ok(accept(all.text, actor).startsWith(`import { Actor, FakeActor } from "/Script/FakeEngine";\n`), "value import extends the existing one");
    assert.equal(actor.sortText, "1AFakeActor");
  });
});

test("after extends only classes are offered; in an expression classes and functions but no structs or enums", () => {
  withNames((dir, index) => {
    const heritage = atWith(dir, `export class X extends Fake| {}\n`, index);
    assert.deepEqual(labels(heritage.items), ["FakeActor", "BP_Fake_C"]);
    const impl = atWith(dir, `export class X implements Fake| {}\n`, index);
    assert.deepEqual(labels(impl.items), ["FakeActor", "BP_Fake_C"]);

    const expr = atWith(dir, `export function go(): void {\n  Fake|\n}\n`, index);
    assert.deepEqual(labels(expr.items), ["FakeActor", "BP_Fake_C"]);

    // other type nodes stay empty; a type argument is a type reference
    assert.deepEqual(atWith(dir, `export function go(): void {\n  let v: typeof Fake|;\n}\n`, index).items, []);
    assert.equal(atWith(dir, `export function go(): void {\n  let v: Array<Fake|>;\n}\n`, index).items.length, 4);
  });
});

test("a name already in scope is not offered again", () => {
  withNames((dir, index) => {
    const src = `import { BP_Fake_C } from "/Game/Fake/BP_Fake";\nexport function go(): void {\n  let v: BP_Fa|;\n}\n`;
    assert.deepEqual(labels(atWith(dir, src, index).items), []);
    const local = atWith(dir, `class FakeActor {}\nexport function go(): void {\n  let v: Fake|;\n}\n`, index);
    assert.deepEqual(labels(local.items), ["FakeMode", "FakeVec", "BP_Fake_C"]);
  });
});

test("catalog-only functions are listed after generated ones with the import, and generated ones are not repeated", () => {
  withNames((dir, index) => {
    const names = index.functions.map((f) => `${f.container}.${f.name}`);
    assert.equal(names.filter((n) => n === "KismetSystemLibrary.PrintString").length, 1, "no duplicate of a generated function");
    const { items, text } = atWith(dir, `export function go(): void {\n  Print|\n}\n`, index);
    assert.deepEqual(labels(items), ["PrintString", "PrintText", "PrintAlpha"]);
    const alpha = items[2] as AbfcCompletion;
    assert.equal(alpha.detail, "SpareLibrary.PrintAlpha");
    assert.equal(alpha.labelDescription, "SpareLibrary · not generated yet");
    assert.equal(alpha.documentation, undefined);
    assert.ok(alpha.sortText.startsWith("2"));
    assert.ok((items[0] as AbfcCompletion).sortText.startsWith("1"));
    assert.equal(accept(text, alpha), `import { SpareLibrary } from "/Script/FakeSpare";\nexport function go(): void {\n  SpareLibrary.PrintAlpha\n}\n`);
  });
});

test("malformed _names.json rows are dropped, a missing or wrong-version file gives only the generated functions", () => {
  withNames(
    (_dir, index) => {
      assert.deepEqual(index.types.map((t) => t.name), ["Good"]);
      assert.ok(index.functions.every((f) => f.generated !== false));
    },
    { version: 1, types: [{ name: "Good", module: "/Script/X", path: "/Script/X.Good", kind: "class" }, { name: "Bad", module: "/Script/X", path: "/Script/X.Bad", kind: "union" }, 5, { name: 3 }], functions: [{ name: "F" }, null] },
  );
  withNames(
    (_dir, index) => {
      assert.deepEqual(index.types, []);
      assert.ok(index.functions.length > 0);
    },
    { version: 2, types: NAMES.types },
  );
  withProject((_dir, profile) => {
    const index = buildCompletionIndex(profile);
    assert.deepEqual(index.types, []);
    assert.equal(buildCompletionIndex(profile), index, "cached while the lock and names mtimes stay");
  });
});

test("buildLibraryIndex uses _library.json without walking the stubs, and falls back to the walk when it is invalid", () => {
  withProject((_dir, profile) => {
    const entries: LibraryEntry[] = [{ name: "OnlyInJson", container: "JsonLib", module: "/Script/FakeJson", signature: "(): void", doc: "From the file.", displayName: "Only In Json" }];
    writeFileSync(join(profile, "_library.json"), JSON.stringify({ version: 1, entries }), "utf8");
    assert.deepEqual(buildLibraryIndex(profile), entries, "the d.ts files (with PrintString) are not read");
  });
  withProject((_dir, profile) => {
    writeFileSync(join(profile, "_library.json"), "{ not json", "utf8");
    assert.ok(buildLibraryIndex(profile).some((e) => e.name === "PrintString"));
  });
  withProject((_dir, profile) => {
    writeFileSync(join(profile, "_library.json"), JSON.stringify({ version: 2, entries: [] }), "utf8");
    assert.ok(buildLibraryIndex(profile).some((e) => e.name === "PrintString"));
  });
});

test("libraryEntriesOf is what buildLibraryIndex computes per file", () => {
  withProject((_dir, profile) => {
    const files: Array<[string, string]> = [
      ["Script/FakeEngine.d.ts", readFileSync(join(profile, "Script", "FakeEngine.d.ts"), "utf8")],
      ["Mod/TestMod/Lib/ModLib.d.ts", MOD_LIB],
      ["Script/Empty.d.ts", "export declare class X {}\n"],
    ];
    const got = libraryEntriesOf(files);
    assert.ok(got.some((e) => e.name === "FrobThing" && e.module === "@mod/Lib/ModLib"));
    assert.ok(got.some((e) => e.name === "PrintString" && e.module === "/Script/FakeEngine"));
    assert.equal(got.some((e) => e.name === "PrintOld"), false);
    assert.deepEqual(libraryEntriesOf([]), []);
  });
});

test("25,000 catalog entries: completionsAt answers in well under 50 ms", (t) => {
  const kinds = ["class", "struct", "enum", "class"] as const;
  const stems = ["Actor", "Pawn", "Widget", "Timer", "Health", "Spawn", "Player", "Vector", "Event", "Item"];
  const types = Array.from({ length: 25_000 }, (_, i) => ({
    name: `${stems[i % stems.length]}${stems[(i * 7) % stems.length]}${i}`,
    module: `/Script/Fake${i % 40}`,
    path: `/Script/Fake${i % 40}.X${i}`,
    kind: kinds[i % kinds.length],
  }));
  withNames(
    (dir, index) => {
      assert.equal(index.types.length, 25_000);
      const file = join(dir, "src", "Comp.ts");
      const prefixes = ["A", "Ac", "Act", "Pla", "Wid", "Tim", "Health", "Sp", "Ve", "Ev", "Ite", "Pa", "He", "Spa", "Play", "Vec", "Eve", "It", "W", "T"];
      const times: number[] = [];
      for (const p of prefixes) {
        const source = `export function go(): void {\n  ${p}\n}\n`;
        writeFileSync(file, source, "utf8");
        const loaded = loadProgram(dir); // the program load is not part of the measured lookup
        const pos = source.indexOf(`${p}\n`) + p.length;
        const t0 = performance.now();
        const items = completionsAt(loaded, file, pos, index);
        times.push(performance.now() - t0);
        assert.ok(items.length > 0 && items.length <= 100, `${p}: ${items.length} items`);
      }
      const total = times.reduce((a, b) => a + b, 0);
      times.sort((a, b) => a - b);
      t.diagnostic(`25k entries, ${prefixes.length} lookups: median ${(times[Math.floor(times.length / 2)] as number).toFixed(2)} ms, max ${(times[times.length - 1] as number).toFixed(2)} ms, total ${total.toFixed(1)} ms`);
      assert.ok(total < 1000, `total ${total.toFixed(1)} ms`);
    },
    { version: 1, types, functions: [] },
  );
});
