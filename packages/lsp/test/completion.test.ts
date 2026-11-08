import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, open, startInMemory } from "./helpers.js";
import type { Started } from "./helpers.js";
import { loadProjectEnvironment } from "../src/environment.js";
import { pathToUri } from "../src/uri.js";

const LIBRARY = `
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
   * Starts a timer that runs the given event after a delay (Set Timer by Event).
   * @bpPath /Script/FakeEngine.KismetSystemLibrary:K2_SetTimerDelegate
   * @bpParam Time double
   * @bpParam bLooping bool
   */
  function K2_SetTimerDelegate(Time: double, bLooping: boolean): void;
}
`;

/**
 * phase4 (an Actor with ReceiveTick/ReceiveBeginPlay) plus a library namespace and a stubs lock. The fixture's tsconfig reads the stubs from
 * `.abfc/stubs/test`; the library index reads the folder of the environment's profile, so the stubs are copied there too.
 */
const prepared = (dir: string): void => {
  const engine = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
  writeFileSync(engine, readFileSync(engine, "utf8") + LIBRARY, "utf8");
  writeFileSync(join(dir, ".abfc", "stubs", "test", "stubs.lock.json"), "{}\n", "utf8");
  cpSync(join(dir, ".abfc", "stubs", "test"), join(dir, ".abfc", "stubs", loadProjectEnvironment(dir).profile.id), { recursive: true });
};

const HEAD = `import { blueprint, event } from "@abfc/runtime";\nimport { Actor } from "/Script/FakeEngine";\n\n`;
const CALL = `${HEAD}@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  @event\n  Go(): void {\n    PrintS|\n  }\n}\n`;
const BODY = `${HEAD}@blueprint({ path: "/TestMod/Phase4/BP_Comp" })\nexport class BP_Comp extends Actor {\n  Rec|\n}\n`;

interface Pos {
  line: number;
  character: number;
}

/** The text without its `|` marker and the position of the marker. */
function mark(source: string): { text: string; position: Pos } {
  const at = source.indexOf("|");
  assert.ok(at >= 0, "marker");
  const text = source.slice(0, at) + source.slice(at + 1);
  const before = source.slice(0, at).split("\n");
  return { text, position: { line: before.length - 1, character: (before[before.length - 1] as string).length } };
}

async function complete(started: Started, dir: string, source: string): Promise<{ items: any[]; text: string }> {
  const { text, position } = mark(source);
  const file = join(dir, "src", "Comp.ts");
  writeFileSync(file, text, "utf8");
  const uri = open(started.client, file, text);
  const result: any = await started.client.request("textDocument/completion", { textDocument: { uri }, position }, 120_000);
  const items: any[] = Array.isArray(result) ? result : (result?.items ?? []);
  return { items, text };
}

/** The file text after accepting an item: its textEdit and additionalTextEdits. */
function accept(text: string, item: any): string {
  const lines = text.split("\n");
  const offsetOf = (p: Pos): number => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const edits = [item.textEdit, ...(item.additionalTextEdits ?? [])].map((e: any) => ({ start: offsetOf(e.range.start), end: offsetOf(e.range.end), newText: e.newText as string }));
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

test("completion: initialize reports the provider", async () => {
  const started = await startInMemory();
  try {
    assert.deepEqual(started.initializeResult.capabilities.completionProvider, { resolveProvider: false });
  } finally {
    await started.dispose();
  }
});

test("completion: PrintS in a method body offers PrintString with the import edit", async () => {
  const dir = copyFixture("phase4", prepared);
  const started = await startInMemory();
  try {
    const { items, text } = await complete(started, dir, CALL);
    const print = items.find((i) => i.label === "PrintString");
    assert.ok(print, items.map((i) => i.label).join());
    assert.equal(print.kind, 3, "CompletionItemKind.Function");
    assert.equal(print.insertTextFormat, 1, "plain text");
    assert.equal(print.detail, "KismetSystemLibrary.PrintString(InString?: string): void");
    assert.equal(print.documentation.value, "Prints a string to the screen and the log.");
    assert.equal(print.textEdit.newText, "KismetSystemLibrary.PrintString");
    assert.deepEqual(print.textEdit.range, { start: { line: 7, character: 4 }, end: { line: 7, character: 10 } });
    assert.equal(print.filterText, "PrintString");
    assert.equal(print.sortText, "1APrintString");
    assert.equal(print.labelDetails?.description, "KismetSystemLibrary");
    assert.equal(print.additionalTextEdits.length, 1);
    assert.equal(
      accept(text, print),
      text.replace('import { Actor } from "/Script/FakeEngine";', 'import { Actor, KismetSystemLibrary } from "/Script/FakeEngine";').replace("PrintS\n", "KismetSystemLibrary.PrintString\n"),
    );
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completion: settimer, timer, timerdelegate, settimerdelegate and Set Timer by Event offer KismetSystemLibrary.K2_SetTimerDelegate with the import", async () => {
  const dir = copyFixture("phase4", prepared);
  const started = await startInMemory();
  try {
    const cases: Array<[string, string]> = [
      ["settimer", "SetTimerDelegate"],
      ["timer", "TimerDelegate"],
      ["timerdelegate", "TimerDelegate"],
      ["settimerdelegate", "SetTimerDelegate"],
      ["SetTimerByEv", "SetTimerbyEvent"],
    ];
    for (const [typed, filterText] of cases) {
      const { items, text } = await complete(started, dir, CALL.replace("PrintS|", `${typed}|`));
      const timer = items.find((i) => i.label === "K2_SetTimerDelegate");
      assert.ok(timer, `${typed}: ${items.map((i) => i.label).join()}`);
      assert.equal(timer.textEdit.newText, "KismetSystemLibrary.K2_SetTimerDelegate");
      assert.equal(timer.filterText, filterText);
      assert.equal(timer.labelDetails?.description, "KismetSystemLibrary · Set Timer by Event");
      assert.equal(
        accept(text, timer),
        text.replace('import { Actor } from "/Script/FakeEngine";', 'import { Actor, KismetSystemLibrary } from "/Script/FakeEngine";').replace(`${typed}\n`, "KismetSystemLibrary.K2_SetTimerDelegate\n"),
      );
    }
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completion: Rec in a class body offers the ReceiveBeginPlay override snippet", async () => {
  const dir = copyFixture("phase4", prepared);
  const started = await startInMemory();
  try {
    const { items, text } = await complete(started, dir, BODY);
    const begin = items.find((i) => i.label === "ReceiveBeginPlay");
    assert.ok(begin, items.map((i) => i.label).join());
    assert.equal(begin.kind, 2, "CompletionItemKind.Method");
    assert.equal(begin.insertTextFormat, 2, "snippet");
    assert.equal(begin.textEdit.newText, "@override override ReceiveBeginPlay(): void {\n\t$0\n}");
    assert.equal(begin.sortText, "0ReceiveBeginPlay");
    assert.ok(items.some((i) => i.label === "ReceiveTick"));
    const accepted = accept(text, begin);
    assert.match(accepted, /^import \{ blueprint, event, override \} from "@abfc\/runtime";/);
    assert.match(accepted, /  @override override ReceiveBeginPlay\(\): void \{\n\t\$0\n\}\n\}\n$/);
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completion: nothing in a comment, an unknown document or a position past the end; the server keeps answering", async () => {
  const dir = copyFixture("phase4", prepared);
  const started = await startInMemory();
  try {
    const inComment = await complete(started, dir, CALL.replace("    PrintS|\n", "    // PrintS|\n"));
    assert.deepEqual(inComment.items, []);
    const unknown: any = await started.client.request("textDocument/completion", {
      textDocument: { uri: pathToUri(join(dir, "src", "Never.ts")) },
      position: { line: 0, character: 0 },
    });
    assert.deepEqual(unknown, []);
    const file = join(dir, "src", "Comp.ts");
    const uri = pathToUri(file);
    const far: any = await started.client.request("textDocument/completion", { textDocument: { uri }, position: { line: 999, character: 0 } });
    assert.ok(Array.isArray(far) ? far.length === 0 : (far?.items ?? []).length === 0);
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completion: a class from the catalog names file is offered with its import, in an expression and in a type position", async () => {
  const dir = copyFixture("phase4", (d) => {
    prepared(d);
    const profile = join(d, ".abfc", "stubs", loadProjectEnvironment(d).profile.id);
    const names = { version: 1, types: [{ name: "BP_Fake_C", module: "/Game/Fake/BP_Fake", path: "/Game/Fake/BP_Fake.BP_Fake_C", kind: "class" }], functions: [] };
    writeFileSync(join(profile, "_names.json"), JSON.stringify(names), "utf8");
  });
  const started = await startInMemory();
  try {
    const inType = await complete(started, dir, `${HEAD}export function go(): void {\n  let v: BP_Fa|;\n}\n`);
    const cls = inType.items.find((i) => i.label === "BP_Fake_C");
    assert.ok(cls, inType.items.map((i) => i.label).join());
    assert.equal(cls.kind, 7, "CompletionItemKind.Class");
    assert.equal(cls.detail, "/Game/Fake/BP_Fake.BP_Fake_C");
    assert.equal(cls.labelDetails?.description, "/Game/Fake/BP_Fake");
    const accepted = accept(inType.text, cls);
    assert.ok(accepted.includes(`import { BP_Fake_C } from "/Game/Fake/BP_Fake";`), accepted);
    assert.ok(accepted.includes("let v: BP_Fake_C;"), accepted);

    const inExpr = await complete(started, dir, `${HEAD}export function go(): void {\n  BP_Fa|\n}\n`);
    assert.ok(inExpr.items.some((i) => i.label === "BP_Fake_C"), inExpr.items.map((i) => i.label).join());
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
