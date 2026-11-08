// Spawns the real command (`abfc lsp --stdio`) and talks to it over its pipes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StdioLspClient, loadProjectEnvironment } from "@abfc/lsp";
import { parseCliArgs } from "../src/args.js";

// compiled to packages/cli/dist/test/; the project copy sits inside that folder so that `@abfc/runtime` resolves.
const here = dirname(fileURLToPath(import.meta.url));
const binJs = join(here, "..", "src", "bin.js");
const fixture = join(here, "..", "..", "..", "compiler", "test", "fixtures", "project");

interface Pos {
  line: number;
  character: number;
}

function posOf(text: string, needle: string, inside = 1): Pos {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `${needle} in the text`);
  const before = text.slice(0, at + inside).split("\n");
  return { line: before.length - 1, character: (before[before.length - 1] as string).length };
}

test("the command line accepts lsp, --stdio and --clientProcessId", () => {
  const a = parseCliArgs(["lsp", "--stdio", "--clientProcessId=12"]);
  assert.equal(a.command, "lsp");
  assert.deepEqual(a.positionals, []);
  assert.equal(parseCliArgs(["lsp"]).command, "lsp");
});

test("abfc lsp --stdio: initialize, didOpen, diagnostics, hover, codeAction, shutdown, exit", async () => {
  const dir = mkdtempSync(join(here, "lsp-"));
  cpSync(fixture, dir, { recursive: true });
  writeFileSync(join(dir, "abf.config.json"), JSON.stringify({ schemaVersion: 2, mod: { name: "TestMod" } }), "utf8");
  // no fixture stub carries a description: give GetPawnThing one
  const stub = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
  const stubText = readFileSync(stub, "utf8");
  const patched = stubText.replace(
    "  /**\n   * @bpPath /Script/FakeEngine.FakeController:GetPawnThing\n",
    "  /**\n   * Returns the pawn this controller drives.\n   * @bpPath /Script/FakeEngine.FakeController:GetPawnThing\n",
  );
  assert.notEqual(patched, stubText, "the stub was patched");
  writeFileSync(stub, patched, "utf8");
  const child = spawn(process.execPath, [binJs, "lsp", "--stdio", "--clientProcessId=" + process.pid], {
    cwd: dir,
    env: { ...process.env, ABFC_USER_CONFIG: join(dir, "no-user-config.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const client = new StdioLspClient(child.stdout, child.stdin);
  try {
    const init: any = await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      capabilities: {},
      initializationOptions: { debounceMs: 0 },
    });
    assert.ok(init.capabilities.hoverProvider);
    assert.ok(init.capabilities.codeActionProvider);
    assert.equal(init.capabilities.textDocumentSync.change, 2);
    client.notify("initialized", {});

    const bad = join(dir, "src", "Bad.ts");
    const badText = readFileSync(bad, "utf8");
    const badUri = pathToFileURL(bad).href;
    client.notify("textDocument/didOpen", { textDocument: { uri: badUri, languageId: "typescript", version: 1, text: badText } });
    const ds = await client.waitForDiagnostics(badUri, (x) => x.some((d: any) => d.code === "ABFC2010"), 120_000);
    const idiv: any = ds.find((d: any) => d.code === "ABFC2010");
    assert.ok(idiv);

    // hover on a stub member call works although the project has errors
    const relay = join(dir, "src", "Relay.ts");
    const relayText = readFileSync(relay, "utf8");
    const relayUri = pathToFileURL(relay).href;
    client.notify("textDocument/didOpen", { textDocument: { uri: relayUri, languageId: "typescript", version: 1, text: relayText } });
    const hover: any = await client.request("textDocument/hover", { textDocument: { uri: relayUri }, position: posOf(relayText, "GetPawnThing", 3) }, 120_000);
    assert.ok(hover, "hover on a stub member");
    assert.equal(hover.contents.kind, "markdown");
    assert.match(hover.contents.value, /^Returns the pawn this controller drives\./);

    const actions: any[] = await client.request("textDocument/codeAction", {
      textDocument: { uri: badUri },
      range: idiv.range,
      context: { diagnostics: [] },
    });
    assert.ok(
      actions.some((a) => a.title === "Use idiv(a, b) (Blueprint Divide_IntInt)"),
      JSON.stringify(actions.map((a) => a.title)),
    );

    assert.equal(await client.request("shutdown", null), null);
    client.notify("exit", null);
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([exited, new Promise<string>((r) => (timer = setTimeout(() => r("timeout"), 20_000)))]);
    clearTimeout(timer);
    assert.equal(code, 0, `exit code (stderr: ${stderr.slice(0, 400)})`);
    assert.deepEqual(client.protocolErrors, [], "stdout carries only protocol messages");
  } finally {
    client.close();
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abfc lsp --stdio: completion offers the library function with its import edit and the override snippet", async () => {
  const dir = mkdtempSync(join(here, "lsp-"));
  cpSync(fixture, dir, { recursive: true });
  writeFileSync(join(dir, "abf.config.json"), JSON.stringify({ schemaVersion: 2, mod: { name: "TestMod" } }), "utf8");
  // the fixture's tsconfig reads `.abfc/stubs/test`; the library index reads the folder of the environment's profile: copy the stubs there
  const engine = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
  const engineText = readFileSync(engine, "utf8");
  const withEvent = engineText.replace(
    "export declare class Actor extends UObject {}",
    "export declare class Actor extends UObject {\n  /**\n   * @bpPath /Script/FakeEngine.Actor:ReceiveBeginPlay\n   */\n  ReceiveBeginPlay(): void;\n}",
  );
  assert.notEqual(withEvent, engineText, "the stub was patched");
  writeFileSync(engine, withEvent, "utf8");
  writeFileSync(join(dir, ".abfc", "stubs", "test", "stubs.lock.json"), "{}\n", "utf8");
  const userConfig = join(dir, "no-user-config.json");
  const saved = process.env.ABFC_USER_CONFIG;
  process.env.ABFC_USER_CONFIG = userConfig;
  try {
    cpSync(join(dir, ".abfc", "stubs", "test"), join(dir, ".abfc", "stubs", loadProjectEnvironment(dir).profile.id), { recursive: true });
  } finally {
    if (saved === undefined) delete process.env.ABFC_USER_CONFIG;
    else process.env.ABFC_USER_CONFIG = saved;
  }
  const child = spawn(process.execPath, [binJs, "lsp", "--stdio", "--clientProcessId=" + process.pid], {
    cwd: dir,
    env: { ...process.env, ABFC_USER_CONFIG: userConfig },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const client = new StdioLspClient(child.stdout, child.stdin);
  let incomplete: unknown;
  const complete = async (source: string): Promise<any[]> => {
    const at = source.indexOf("|");
    assert.ok(at >= 0, "marker");
    const text = source.slice(0, at) + source.slice(at + 1);
    const before = source.slice(0, at).split("\n");
    const file = join(dir, "src", "Comp.ts");
    writeFileSync(file, text, "utf8"); // the program sees a file through its tsconfig include
    const uri = pathToFileURL(file).href;
    client.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text } });
    const result: any = await client.request(
      "textDocument/completion",
      { textDocument: { uri }, position: { line: before.length - 1, character: (before[before.length - 1] as string).length } },
      120_000,
    );
    client.notify("textDocument/didClose", { textDocument: { uri } });
    incomplete = Array.isArray(result) ? undefined : result?.isIncomplete;
    return Array.isArray(result) ? result : (result?.items ?? []);
  };
  try {
    const init: any = await client.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      capabilities: {},
      initializationOptions: { debounceMs: 0 },
    });
    assert.deepEqual(init.capabilities.completionProvider, { resolveProvider: false });
    client.notify("initialized", {});

    const head = `import { blueprint, event } from "@abfc/runtime";\nimport { Actor } from "/Script/FakeEngine";\n\n@blueprint({ path: "/TestMod/Relay/BP_Comp" })\nexport class BP_Comp extends Actor {\n`;
    const calls = await complete(`${head}  @event\n  Go(): void {\n    PrintS|\n  }\n}\n`);
    const print = calls.find((i) => i.label === "PrintString");
    assert.ok(print, JSON.stringify(calls.map((i) => i.label)));
    assert.equal(print.textEdit.newText, "KismetSystemLibrary.PrintString");
    assert.equal(incomplete, true, "the list is capped and prefix-filtered on the server: the client asks again as the word grows");
    assert.equal(print.additionalTextEdits.length, 1);
    assert.equal(print.additionalTextEdits[0].newText, ", KismetSystemLibrary", "inserted after the Actor binding of the existing import");

    const members = await complete(`${head}  Rec|\n}\n`);
    const begin = members.find((i) => i.label === "ReceiveBeginPlay");
    assert.ok(begin, JSON.stringify(members.map((i) => i.label)));
    assert.equal(begin.insertTextFormat, 2);
    assert.equal(begin.textEdit.newText, "@override override ReceiveBeginPlay(): void {\n\t$0\n}");
    assert.ok(begin.additionalTextEdits.length >= 1, "the override import");

    assert.equal(await client.request("shutdown", null), null);
    client.notify("exit", null);
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([exited, new Promise<string>((r) => (timer = setTimeout(() => r("timeout"), 20_000)))]);
    clearTimeout(timer);
    assert.equal(code, 0, `exit code (stderr: ${stderr.slice(0, 400)})`);
    assert.deepEqual(client.protocolErrors, [], "stdout carries only protocol messages");
  } finally {
    client.close();
    child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
