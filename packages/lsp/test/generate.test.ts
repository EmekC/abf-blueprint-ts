import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runGenerateStubs } from "../src/generate.js";
import type { SpawnFn, StubsChild } from "../src/generate.js";
import { copyFixture, open, sleep, startInMemory } from "./helpers.js";

const LAUNCH = { command: "node", args: ["abfc.js"] };

interface Fake extends StubsChild {
  emitter: EventEmitter;
  out: PassThrough;
  err: PassThrough;
}

interface Call {
  command: string;
  args: string[];
  options: { windowsHide?: boolean; stdio?: string[] };
}

/** A child process that ends when `finish` is called. */
function fakeChild(): Fake {
  const emitter = new EventEmitter();
  const out = new PassThrough();
  const err = new PassThrough();
  return {
    emitter,
    out,
    err,
    stdout: out,
    stderr: err,
    on(event: string, listener: (...a: never[]) => void) {
      emitter.on(event, listener as (...a: unknown[]) => void);
      return emitter;
    },
  } as Fake;
}

function spawner(child: Fake, calls: Call[] = []): SpawnFn {
  return (command, args, options) => {
    calls.push({ command, args, options: options as Call["options"] });
    return child;
  };
}

async function finish(child: Fake, stdout: string, stderr: string, code: number): Promise<void> {
  child.out.write(stdout);
  child.err.write(stderr);
  await sleep(5);
  child.emitter.emit("close", code);
}

const okEnvelope = (result: object): string => JSON.stringify({ command: "generate", ok: true, diagnostics: [], result });

test("runGenerateStubs: success builds the command line and reports the names", async () => {
  const child = fakeChild();
  const calls: Call[] = [];
  const p = runGenerateStubs(LAUNCH, "C:\\proj\\a", ["/Script/FakeEngine.Thing", "/Game/Fake/BP_Fake"], spawner(child, calls));
  await finish(child, okEnvelope({ reflected: 2, notFound: [] }), "stubs: info\n", 0);
  const r = await p;
  assert.deepEqual(r, { ok: true, message: "abfc: stubs generated for /Script/FakeEngine.Thing, /Game/Fake/BP_Fake" });
  assert.equal(calls[0]?.command, "node");
  assert.deepEqual(calls[0]?.args, ["abfc.js", "generate", "--project", "C:\\proj\\a", "--json", "--add=/Script/FakeEngine.Thing", "--add=/Game/Fake/BP_Fake"]);
  assert.equal(calls[0]?.options.windowsHide, true);
  assert.equal(calls[0]?.options.stdio?.[0], "ignore", "stdin is not connected");
});

test("runGenerateStubs: already up to date, and names the backend did not know", async () => {
  const a = fakeChild();
  const p = runGenerateStubs(LAUNCH, "C:\\proj\\b", ["/Script/FakeEngine.Thing"], spawner(a));
  await finish(a, okEnvelope({ reflected: 0, notFound: [] }), "", 0);
  assert.equal((await p).message, "abfc: stubs for /Script/FakeEngine.Thing are already up to date");

  const b = fakeChild();
  const q = runGenerateStubs(LAUNCH, "C:\\proj\\b", ["/Script/FakeEngine.Nope"], spawner(b));
  await finish(b, okEnvelope({ reflected: 0, notFound: ["/Script/FakeEngine.Nope"] }), "", 0);
  const r = await q;
  assert.equal(r.ok, false);
  assert.match(r.message, /nothing generated for \/Script\/FakeEngine\.Nope/);
});

test("runGenerateStubs: a failed envelope reports its first error; without one the last stderr line; start errors are reported", async () => {
  const a = fakeChild();
  const p = runGenerateStubs(LAUNCH, "C:\\proj\\c", ["/Script/FakeEngine.Thing"], spawner(a));
  const failed = { command: "generate", ok: false, diagnostics: [{ severity: "warning", code: "ABFC3021", message: "w" }, { severity: "error", code: "ABFC4019", message: "another abfc command is running" }], result: null };
  await finish(a, JSON.stringify(failed), "", 1);
  assert.deepEqual(await p, { ok: false, message: "ABFC4019: another abfc command is running" });

  const b = fakeChild();
  const q = runGenerateStubs(LAUNCH, "C:\\proj\\c", ["/Script/FakeEngine.Thing"], spawner(b));
  await finish(b, "", "first\nboom happened\n\n", 2);
  assert.deepEqual(await q, { ok: false, message: "boom happened" });

  const c = fakeChild();
  const r = runGenerateStubs(LAUNCH, "C:\\proj\\c", ["/Script/FakeEngine.Thing"], spawner(c));
  c.emitter.emit("error", new Error("spawn ENOENT"));
  assert.deepEqual(await r, { ok: false, message: "could not start abfc generate: spawn ENOENT" });

  const throwing: SpawnFn = () => {
    throw new Error("no such file");
  };
  assert.deepEqual(await runGenerateStubs(LAUNCH, "C:\\proj\\c", ["/Script/FakeEngine.Thing"], throwing), { ok: false, message: "could not start abfc generate: no such file" });
});

test("runGenerateStubs: one run per project at a time, other projects are independent", async () => {
  const a = fakeChild();
  const first = runGenerateStubs(LAUNCH, "C:\\proj\\d", ["/Script/FakeEngine.A"], spawner(a));
  const second = await runGenerateStubs(LAUNCH, "C:\\proj\\d", ["/Script/FakeEngine.B"], spawner(fakeChild()));
  assert.deepEqual(second, { ok: false, message: "abfc generate is already running for this project" });
  const other = fakeChild();
  const third = runGenerateStubs(LAUNCH, "C:\\proj\\e", ["/Script/FakeEngine.C"], spawner(other));
  await finish(other, okEnvelope({ reflected: 1 }), "", 0);
  assert.equal((await third).ok, true);
  await finish(a, okEnvelope({ reflected: 1 }), "", 0);
  assert.equal((await first).ok, true);
  const again = fakeChild();
  const next = runGenerateStubs(LAUNCH, "C:\\proj\\d", ["/Script/FakeEngine.A"], spawner(again));
  await finish(again, okEnvelope({ reflected: 1 }), "", 0);
  assert.equal((await next).ok, true, "a new run may start once the first ended");
});

test("abfc.generateStubs over the server: runs the CLI and tells the client; bad arguments and failures are shown", async () => {
  const dir = copyFixture("phase4");
  const child = fakeChild();
  const calls: Call[] = [];
  const started = await startInMemory({}, {}, { cliLaunch: LAUNCH, spawnFn: spawner(child, calls) });
  const failing = fakeChild();
  const failStarted = await startInMemory({}, {}, { cliLaunch: LAUNCH, spawnFn: spawner(failing) });
  try {
    const file = join(dir, "src", "Comp.ts");
    open(started.client, file, "export const a = 1;\n");
    open(failStarted.client, file, "export const a = 1;\n");
    await sleep(100);
    const exec = (s: typeof started, args: unknown): Promise<any> => s.client.request("workspace/executeCommand", { command: "abfc.generateStubs", arguments: [args] });

    assert.deepEqual(await exec(started, { projectDir: 5 }), { ok: false }, "bad arguments");
    assert.deepEqual(await exec(started, { projectDir: join(dir, "nowhere"), add: ["/Script/X.Y"] }), { ok: false }, "not an open project");
    assert.equal(calls.length, 0, "nothing was started for either");

    const run = exec(started, { projectDir: dir, add: ["/Script/FakeEngine.Thing"] });
    await sleep(100);
    assert.equal(calls.length, 1, "the CLI is started once");
    await finish(child, okEnvelope({ reflected: 1 }), "", 0);
    assert.equal((await run).ok, true);
    const shown = started.client.serverRequests.filter((r) => r.method === "window/showMessageRequest").map((r) => r.params.message as string);
    assert.ok(shown.some((m) => m.includes("generating stubs for /Script/FakeEngine.Thing")), shown.join("|"));
    assert.ok(shown.some((m) => m.includes("stubs generated for /Script/FakeEngine.Thing")), shown.join("|"));

    const bad = exec(failStarted, { projectDir: dir, add: ["/Script/FakeEngine.Thing"] });
    await sleep(100);
    const failed = { command: "generate", ok: false, diagnostics: [{ severity: "error", code: "ABFC4019", message: "another abfc command is running" }], result: null };
    await finish(failing, JSON.stringify(failed), "", 1);
    assert.equal((await bad).ok, false);
    const msgs = failStarted.client.serverRequests.filter((r) => r.method === "window/showMessageRequest");
    const last = msgs[msgs.length - 1];
    assert.equal(last?.params.type, 1, "an error message");
    assert.match(last?.params.message, /ABFC4019/);
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    await failStarted.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
