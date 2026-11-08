import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectState, diskStamp } from "../src/project.js";
import { WATCHED_GLOBS } from "../src/server.js";
import { pathToUri } from "../src/uri.js";
import { copyFixture, open, sleep, startInMemory } from "./helpers.js";

const retiredHideAll = JSON.stringify({ "/TestMod/Relay/BP_Relay": ["event:HideAll"] });

const missingHideAll = (ds: Array<{ code?: string | number | undefined; message: string }>): boolean =>
  ds.some((d) => d.code === "ABFC2000" && d.message.startsWith("[TS2339]") && d.message.includes("HideAll"));

test("the stub filter follows retired.json: watched-file notification, then the disk stamp after an edit", async () => {
  const dir = copyFixture("project", (d) => rmSync(join(d, "src", "Bad.ts")));
  const started = await startInMemory({ tsDiagnostics: true });
  try {
    const retired = join(dir, ".abfc", "stubs", "test", "retired.json");
    writeFileSync(retired, "{}", "utf8");
    const relay = join(dir, "src", "Relay.ts");
    const text = readFileSync(relay, "utf8");
    const uri = open(started.client, relay, text);
    const first = await started.client.waitForDiagnostics(uri);
    assert.equal(missingHideAll(first), false, "unfiltered stubs declare HideAll");

    // abfc build retired HideAll while the editor was open; the client reports the change
    writeFileSync(retired, retiredHideAll, "utf8");
    started.client.forget(uri);
    started.client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToUri(retired), type: 2 }] });
    const second = await started.client.waitForDiagnostics(uri, missingHideAll);
    assert.equal(missingHideAll(second), true);

    // a later change that nobody reports is noticed by the disk stamp once its one-second cache has expired
    writeFileSync(retired, "{}", "utf8");
    await sleep(1100);
    started.client.forget(uri);
    started.client.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text }] });
    const third = await started.client.waitForDiagnostics(uri);
    assert.equal(missingHideAll(third), false, "the stale filter is dropped");
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the disk stamp alone rebuilds a clean project (no notification, no edit)", async () => {
  const dir = copyFixture("project", (d) => rmSync(join(d, "src", "Bad.ts")));
  try {
    const retired = join(dir, ".abfc", "stubs", "test", "retired.json");
    writeFileSync(retired, "{}", "utf8");
    const relay = join(dir, "src", "Relay.ts");
    const state = new ProjectState(dir, () => undefined);
    state.docs.set(ProjectState.keyOf(relay), { uri: pathToUri(relay), path: relay });
    const a = state.snapshot();
    assert.ok(a);
    assert.equal(state.snapshot(), a, "nothing changed: the same snapshot");
    const sf = a.byKey.get(ProjectState.keyOf(relay));
    assert.ok(sf);
    assert.equal(missingHideAll(state.tsDiagnosticsOf(a, sf).map((d) => ({ code: d.code, message: d.message }))), false);

    const before = diskStamp(dir);
    writeFileSync(retired, retiredHideAll, "utf8");
    assert.notEqual(diskStamp(dir), before, "the stamp covers retired.json");
    assert.equal(state.snapshot(), a, "within one second the stamp is not recomputed");
    await sleep(1100);
    const b = state.snapshot();
    assert.ok(b);
    assert.notEqual(b, a, "the program was rebuilt");
    const sfB = b.byKey.get(ProjectState.keyOf(relay));
    assert.ok(sfB);
    assert.equal(missingHideAll(state.tsDiagnosticsOf(b, sfB).map((d) => ({ code: d.code, message: d.message }))), true);
    assert.equal(state.snapshot(), b, "stable again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stamp covers manifests, stub locks, the config and the tsconfig files", () => {
  const dir = copyFixture("project");
  try {
    const stamp = (): string => diskStamp(dir);
    let last = stamp();
    const change = (what: string, write: () => void): void => {
      write();
      const now = stamp();
      assert.notEqual(now, last, what);
      last = now;
    };
    change("a manifest appears", () => {
      mkdirSync(join(dir, ".abfc", "manifest"), { recursive: true });
      writeFileSync(join(dir, ".abfc", "manifest", "unit.json"), "{}", "utf8");
    });
    change("tsconfig.paths.json appears", () => writeFileSync(join(dir, ".abfc", "tsconfig.paths.json"), "{}", "utf8"));
    change("a stub lock appears", () => writeFileSync(join(dir, ".abfc", "stubs", "test", "stubs.lock.json"), "{}", "utf8"));
    change("the config changes", () => writeFileSync(join(dir, "abf.config.json"), JSON.stringify({ schemaVersion: 2, mod: { name: "TestMod" }, sourceRoot: "src" }), "utf8"));
    change("tsconfig.json changes", () => writeFileSync(join(dir, "tsconfig.json"), readFileSync(join(dir, "tsconfig.json"), "utf8") + "\n", "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a client that can register watchers gets the globs; others get no request", async () => {
  const withWatch = await startInMemory({}, { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } });
  const without = await startInMemory();
  try {
    for (let i = 0; i < 50 && withWatch.client.serverRequests.length === 0; i++) await sleep(50);
    const reg = withWatch.client.serverRequests.find((r) => r.method === "client/registerCapability");
    assert.ok(reg, "client/registerCapability was sent");
    const registration = reg.params.registrations[0];
    assert.equal(registration.method, "workspace/didChangeWatchedFiles");
    assert.deepEqual(
      registration.registerOptions.watchers.map((w: { globPattern: string }) => w.globPattern),
      WATCHED_GLOBS,
    );
    await sleep(200);
    assert.deepEqual(without.client.serverRequests, []);
  } finally {
    await withWatch.dispose();
    await without.dispose();
  }
});

test("a watched-file change outside every project is ignored and the server keeps answering", async () => {
  const started = await startInMemory();
  try {
    started.client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToUri(join(process.cwd(), "elsewhere", "abf.config.json")), type: 2 }] });
    started.client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: "untitled:Untitled-1", type: 2 }] });
    assert.equal(await started.client.request("shutdown", null, 5000), null);
  } finally {
    started.client.close();
  }
});
