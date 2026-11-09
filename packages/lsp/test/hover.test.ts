import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyFixture, open, startInMemory } from "./helpers.js";
import type { Started } from "./helpers.js";

/** The `project` fixture without Bad.ts (so that the program lowers cleanly) and with a described stub member (GetPawnThing). */
const prepared = (dir: string): void => {
  rmSync(join(dir, "src", "Bad.ts"));
  const stub = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
  const text = readFileSync(stub, "utf8");
  const patched = text.replace("  /**\n   * @bpPath /Script/FakeEngine.FakeController:GetPawnThing\n", "  /**\n   * Returns the pawn this controller drives.\n   * Second line of the description.\n   * @bpPath /Script/FakeEngine.FakeController:GetPawnThing\n");
  assert.notEqual(patched, text, "the stub was patched");
  writeFileSync(stub, patched, "utf8");
};

interface Pos {
  line: number;
  character: number;
}

/** The position `inside` characters after the first `needle` in `text`. */
function posOf(text: string, needle: string, inside = 1): Pos {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `${needle} in the text`);
  const before = text.slice(0, at + inside).split("\n");
  return { line: before.length - 1, character: (before[before.length - 1] as string).length };
}

async function hover(started: Started, uri: string, position: Pos): Promise<{ contents: { kind: string; value: string } } | null> {
  return started.client.request("textDocument/hover", { textDocument: { uri }, position });
}

test("hover: a statement shows its Blueprint nodes, a stub member also its description", async () => {
  const dir = copyFixture("project", prepared);
  const started = await startInMemory();
  try {
    assert.equal(started.initializeResult.capabilities.hoverProvider, true);
    const file = join(dir, "src", "Relay.ts");
    const text = readFileSync(file, "utf8");
    const uri = open(started.client, file);

    const cast = await hover(started, uri, posOf(text, "cast(player?.Target", 1));
    assert.ok(cast, "hover inside cast(...)");
    assert.equal(cast.contents.kind, "markdown");
    assert.match(cast.contents.value, /Blueprint: .*Cast To /);
    assert.doesNotMatch(cast.contents.value, /```/, "no TypeScript block without tsHover");

    const member = await hover(started, uri, posOf(text, "GetPawnThing", 3));
    assert.ok(member, "hover on a stub member");
    assert.match(member.contents.value, /^Returns the pawn this controller drives\./);
    assert.doesNotMatch(member.contents.value, /Second line/, "only the first description line");
    assert.match(member.contents.value, /Blueprint: /, "the statement's nodes follow");
    assert.match(member.contents.value, /\[Docs\]\(https:\/\/emekc\.github\.io\/abf-blueprint-ts\/reference\/nodes\/fakecontroller-getpawnthing\/\)/);
    const parts = member.contents.value.split("\n\n");
    assert.match(parts[0] ?? "", /^Returns the pawn this controller drives\./);
    assert.match(parts[1] ?? "", /^\[Docs\]\(/, "the link follows the description");
    assert.match(parts[2] ?? "", /^Blueprint: /, "the node line follows the link");
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hover: links /Script stub functions, not /Game members", async () => {
  const dir = copyFixture("project", prepared);
  const started = await startInMemory();
  try {
    const file = join(dir, "src", "Relay.ts");
    const text = readFileSync(file, "utf8");
    const uri = open(started.client, file);
    const lib = await hover(started, uri, posOf(text, "RowToName", 2));
    assert.ok(lib, "hover on a library function");
    assert.match(lib.contents.value, /reference\/nodes\/fakelibrary-rowtoname\/\)/);
    for (const at of [posOf(text, "Show(info", 1), posOf(text, "player?.Target", 9)]) {
      const result = await hover(started, uri, at);
      assert.ok(result === null || !/\[Docs\]/.test(result.contents.value), "no docs link for a /Game member");
    }
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hover: tsHover adds a typescript block with the symbol and its type", async () => {
  const dir = copyFixture("project", prepared);
  const started = await startInMemory({ tsHover: true });
  try {
    const file = join(dir, "src", "Relay.ts");
    const text = readFileSync(file, "utf8");
    const uri = open(started.client, file);
    const h = await hover(started, uri, posOf(text, "const pot = ", "const ".length + 1));
    assert.ok(h);
    assert.match(h.contents.value, /^```typescript\npot: .*BP_FakePot_C.*\n```/);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hover: whitespace has nothing to say", async () => {
  const dir = copyFixture("project", prepared);
  const started = await startInMemory();
  try {
    const file = join(dir, "src", "Relay.ts");
    const text = readFileSync(file, "utf8");
    const uri = open(started.client, file);
    const blank = text.split("\n").findIndex((l) => l === "");
    assert.ok(blank > 0);
    assert.equal(await hover(started, uri, { line: blank, character: 0 }), null);
    assert.equal(await hover(started, uri, { line: 9999, character: 0 }), null, "a position past the end");
    assert.equal(await started.client.request("textDocument/hover", { textDocument: { uri: "file:///nowhere/x.ts" }, position: { line: 0, character: 0 } }), null, "an unknown document");
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hover: with an error in the project the stub description still shows, the Blueprint nodes do not", async () => {
  const dir = copyFixture("project", (d) => {
    prepared(d);
    writeFileSync(join(d, "src", "Bad.ts"), "export const broken: number = 1 / 0;\nconst x: string = 3;\n", "utf8");
  });
  const started = await startInMemory();
  try {
    const file = join(dir, "src", "Relay.ts");
    const text = readFileSync(file, "utf8");
    const uri = open(started.client, file);
    open(started.client, join(dir, "src", "Bad.ts"));
    const h = await hover(started, uri, posOf(text, "GetPawnThing", 3));
    assert.ok(h);
    assert.match(h.contents.value, /Returns the pawn/);
    assert.doesNotMatch(h.contents.value, /Blueprint: /);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
