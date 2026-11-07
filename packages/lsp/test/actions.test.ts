import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { writeManifest } from "@abfc/compiler";
import type { Manifest } from "@abfc/compiler";
import { copyFixture, fixtureRoot, open, startInMemory } from "./helpers.js";
import type { Started } from "./helpers.js";

interface Pos {
  line: number;
  character: number;
}
interface Range {
  start: Pos;
  end: Pos;
}
interface Edit {
  range: Range;
  newText: string;
}
interface Action {
  title: string;
  kind: string;
  isPreferred?: boolean;
  diagnostics?: Array<{ code?: string | number }>;
  edit: { changes: Record<string, Edit[]> };
}

const posAt = (text: string, offset: number): Pos => {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length - 1, character: (before[before.length - 1] as string).length };
};

/** The range of the first `needle` in `text`. */
function rangeOf(text: string, needle: string): Range {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `${needle} in the text`);
  return { start: posAt(text, at), end: posAt(text, at + needle.length) };
}

const actionsAt = (started: Started, uri: string, range: Range, only?: string[]): Promise<Action[]> =>
  started.client.request("textDocument/codeAction", { textDocument: { uri }, range, context: { diagnostics: [], ...(only !== undefined ? { only } : {}) } });

/** `text` with the edits of `action` applied. */
function apply(uri: string, text: string, action: Action): string {
  const edits = action.edit.changes[uri];
  assert.ok(edits && edits.length > 0, "the action edits the document");
  return TextDocument.applyEdits(TextDocument.create(uri, "typescript", 1, text), edits);
}

function only(actions: Action[], title: string): Action {
  const found = actions.filter((a) => a.title === title);
  assert.equal(found.length, 1, `one action titled "${title}" among ${JSON.stringify(actions.map((a) => a.title))}`);
  const a = found[0] as Action;
  assert.equal(a.kind, "quickfix");
  assert.equal(a.isPreferred, true);
  return a;
}

/** Opens `file`, waits for a diagnostic with `code` and returns it with the URI. */
async function open2(started: Started, file: string, code: string): Promise<{ uri: string; text: string; range: Range }> {
  const text = readFileSync(file, "utf8");
  const uri = open(started.client, file);
  const ds = await started.client.waitForDiagnostics(uri, (x) => x.some((d) => d.code === code));
  const d = ds.find((x) => x.code === code);
  assert.ok(d, `${code} published`);
  return { uri, text, range: d.range };
}

const noBad = (dir: string): void => rmSync(join(dir, "src", "Bad.ts"));

test("code actions: capabilities announce quickfix", async () => {
  const started = await startInMemory();
  try {
    assert.deepEqual(started.initializeResult.capabilities.codeActionProvider, { codeActionKinds: ["quickfix"] });
  } finally {
    await started.dispose();
  }
});

test("code action for ABFC2010 rewrites the division to idiv and adds the import", async () => {
  const dir = copyFixture("project");
  const started = await startInMemory();
  try {
    const { uri, text, range } = await open2(started, join(dir, "src", "Bad.ts"), "ABFC2010");
    const action = only(await actionsAt(started, uri, range), "Use idiv(a, b) (Blueprint Divide_IntInt)");
    assert.equal(action.diagnostics?.[0]?.code, "ABFC2010");
    const fixed = apply(uri, text, action);
    assert.match(fixed, /import \{ blueprint, event, cast, idiv \} from "@abfc\/runtime";/);
    assert.match(fixed, /const q = idiv\(a, b\);/);
    assert.equal(readFileSync(join(dir, "src", "Bad.ts"), "utf8"), text, "the file on disk is untouched");
    // a range elsewhere in the file has no such action; the client's own diagnostics are not needed
    const elsewhere = await actionsAt(started, uri, { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } });
    assert.deepEqual(
      elsewhere.filter((a) => a.title.startsWith("Use idiv")),
      [],
    );
    // a request limited to other kinds gets nothing
    assert.deepEqual(await actionsAt(started, uri, range, ["refactor"]), []);
    assert.equal((await actionsAt(started, uri, range, ["quickfix"])).length > 0, true);
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code action for a possibly-undefined access adds ?. even when tsDiagnostics is off", async () => {
  const src = `export function f(a: { b: number } | undefined): number | undefined {\n  return a.b;\n}\n`;
  const dir = copyFixture("project", (d) => {
    noBad(d);
    writeFileSync(join(d, "src", "Opt.ts"), src, "utf8");
  });
  const started = await startInMemory();
  try {
    const file = join(dir, "src", "Opt.ts");
    const uri = open(started.client, file);
    const ds = await started.client.waitForDiagnostics(uri);
    assert.ok(!ds.some((d) => d.code === "ABFC2000"), "TypeScript's error is not published by default");
    const start = src.indexOf("a.b");
    const range = { start: posAt(src, start), end: posAt(src, start + 1) };
    const action = only(await actionsAt(started, uri, range), "Use ?. (lowers to IsValid + Branch)");
    assert.equal(apply(uri, src, action), src.replace("a.b", "a?.b"));
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code actions for the path and import migration hints (ABFC2006, ABFC2005, ABFC2008)", async () => {
  const dir = copyFixture("phase7");
  const started = await startInMemory();
  try {
    const paths = await open2(started, join(dir, "src", "Paths.ts"), "ABFC2006");
    const remove = only(await actionsAt(started, paths.uri, paths.range), "Remove the redundant path:");
    assert.equal(apply(paths.uri, paths.text, remove), paths.text.replace('@blueprint({ path: "Same" })', "@blueprint()"));

    const abs = await started.client.waitForDiagnostics(paths.uri, (x) => x.some((d) => d.code === "ABFC2005"));
    const absDiag = abs.find((d) => d.code === "ABFC2005");
    assert.ok(absDiag);
    const relative = only(await actionsAt(started, paths.uri, absDiag.range), "Write path: relative to the mod");
    assert.equal(apply(paths.uri, paths.text, relative), paths.text.replace('"/TestMod/Moved/Abs"', '"Moved/Abs"'));

    const imports = await open2(started, join(dir, "src", "Imports.ts"), "ABFC2008");
    const modImport = only(await actionsAt(started, imports.uri, imports.range), "Import from @mod/");
    assert.equal(apply(imports.uri, imports.text, modImport), imports.text.replace('"/TestMod/Relays/BP_Hand"', '"@mod/Relays/BP_Hand"'));
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code action for ABFC2076 replaces classManagerRow with @director", async () => {
  const dir = copyFixture("phase7");
  const started = await startInMemory();
  try {
    const { uri, text, range } = await open2(started, join(dir, "src", "Directors.ts"), "ABFC2076");
    const action = only(await actionsAt(started, uri, range), "Replace classManagerRow with @director");
    const fixed = apply(uri, text, action);
    assert.match(fixed, /@director\("EntityDirector_Old"\)\n@blueprint\(\)\nexport class BPC_OldRow extends Actor/);
    assert.doesNotMatch(fixed, /classManagerRow: "\/TestMod\/DataTables\/DT_ClassManager\/EntityDirector_Old"/);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code action for ABFC5012 keeps the recorded asset path", async () => {
  const dir = copyFixture("phase7", (d) => {
    rmSync(join(d, "src"), { recursive: true, force: true });
    rmSync(join(d, "extra"), { recursive: true, force: true });
    mkdirSync(join(d, "src", "Relays"), { recursive: true });
    writeFileSync(join(d, "src", "Relays", "MyRelay.ts"), readFileSync(join(fixtureRoot, "phase7", "src", "Relays", "MyRelay.ts"), "utf8"), "utf8");
    const manifest: Manifest = {
      asset: "/TestMod/Old/MyRelay",
      compiler: "t",
      profile: "p",
      units: [],
      variables: [],
      source: { file: "src/Old/MyRelay.ts", class: "MyRelay", derived: true },
    };
    writeManifest(d, manifest);
  });
  const started = await startInMemory();
  try {
    const { uri, text, range } = await open2(started, join(dir, "src", "Relays", "MyRelay.ts"), "ABFC5012");
    const action = only(await actionsAt(started, uri, range), 'Keep the existing asset path (path: "Old/MyRelay")');
    assert.equal(apply(uri, text, action), text.replace("@blueprint()", '@blueprint({ path: "Old/MyRelay" })'));
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code actions see the current text: a pending check is flushed first", async () => {
  const dir = copyFixture("project", noBad);
  // a long debounce: only the request itself can bring the check forward
  const started = await startInMemory({ debounceMs: 60000 });
  try {
    const file = join(dir, "src", "Relay.ts");
    const before = readFileSync(file, "utf8");
    const uri = open(started.client, file);
    const whole: Range = { start: { line: 0, character: 0 }, end: posAt(before, before.length) };
    assert.deepEqual(
      (await actionsAt(started, uri, whole)).filter((a) => a.title.startsWith("Use idiv")),
      [],
      "no division yet",
    );

    const classLine = before.split("\n").findIndex((l) => l.startsWith("export class BP_Relay"));
    const lines = before.split("\n");
    lines.splice(classLine + 1, 0, "  @event", "  Divide(a: int, b: int): void {", "    const q = a / b;", "  }", "");
    const after = 'import type { int } from "@abfc/runtime";\n' + lines.join("\n");
    started.client.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: after }] });
    const actions = await actionsAt(started, uri, rangeOf(after, "a / b"));
    const action = only(actions, "Use idiv(a, b) (Blueprint Divide_IntInt)");
    assert.match(apply(uri, after, action), /const q = idiv\(a, b\);/);
    assert.equal(readFileSync(file, "utf8"), before, "the disk file is unchanged");
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
