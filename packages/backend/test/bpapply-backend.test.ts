import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AbfcError } from "@abfc/env";
import { BpApplyBackend, McpStdioClient } from "../src/index.js";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/fake-bpapply-server.mjs", import.meta.url));

type Call = { tool: string; args: Record<string, unknown> };

interface Ctx {
  backend: BpApplyBackend;
  dir: string;
  calls: () => Call[];
}

async function withBackend(config: Record<string, unknown>, fn: (c: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "abfc-backend-test-"));
  const logFile = join(dir, "calls.log");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [FIXTURE],
    cwd: dir,
    env: { ...env, FAKE_LOG: logFile, FAKE_CONFIG: JSON.stringify(config), FAKE_DIR: dir },
    requestTimeoutMs: 10_000,
    closeGraceMs: 5000,
  });
  const backend = new BpApplyBackend(client, { serverDir: "C:\\fake\\server", now: () => new Date(2026, 0, 2, 3, 4, 5) });
  const calls = (): Call[] => {
    try {
      return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
    } catch {
      return [];
    }
  };
  try {
    await fn({ backend, dir, calls });
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rejectsWith(p: Promise<unknown>, code: string): Promise<AbfcError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AbfcError, `expected AbfcError, got ${String(e)}`);
    assert.equal(e.diagnostic.code, code);
    return e;
  }
  assert.fail(`expected ${code}`);
}

test("info with backend_info and abfc_extensions", async () => {
  await withBackend({}, async ({ backend }) => {
    const info = await backend.info();
    assert.equal(info.protocol, 1);
    assert.equal(info.serverVersion, "fake-2");
    assert.equal(info.headlessDir, "C:\\fake-headless");
    assert.equal(info.documentsDir, "C:\\fake-docs");
    assert.equal(info.headlessDirHasSpace, false);
    assert.deepEqual(info.extensions, ["reflect", "compile_node_refs", "bp_read_seconds"]);
    assert.equal(info.capabilities.pinTypes, true);
    assert.equal(info.capabilities.castObjectPin, true);
    assert.equal(info.capabilities.reflect, true);
    assert.equal(info.capabilities.compileErrorNodeRefs, true);
    assert.equal(info.capabilities.containerTypes.map, false);
    assert.equal(info.capabilities.backendContainerTypes?.map, true);
  });
});

test("info without backend_info: protocol null, no error, fallback capabilities", async () => {
  const tools = ["staging_sync", "staging_status", "bp_apply", "bp_read", "bp_compile_report", "bp_game_test", "mod_audit"];
  await withBackend({ tools }, async ({ backend, calls }) => {
    const info = await backend.info();
    assert.equal(info.protocol, null);
    assert.equal(info.headlessDir, null);
    assert.equal(info.headlessDirHasSpace, false);
    assert.deepEqual(info.extensions, []);
    assert.equal(info.capabilities.pinTypes, false);
    assert.equal(info.capabilities.reflect, false);
    assert.equal(info.capabilities.audit, true);
    assert.deepEqual(calls(), []); // nothing was called: neither backend_info nor abfc_extensions is listed
  });
});

test("info: a headless folder with a space is flagged", async () => {
  const backendInfo = {
    protocol: 1,
    headlessDir: "C:\\Users\\Jane Doe\\AppData\\Local\\headless",
    capabilities: { pinTypes: false },
    bpApply: { features: [] },
  };
  await withBackend({ backendInfo }, async ({ backend }) => {
    const info = await backend.info();
    assert.equal(info.headlessDirHasSpace, true);
    assert.equal(info.capabilities.pinTypes, false);
  });
});

test("info: missing core tool -> ABFC4001 naming the tool and the server dir", async () => {
  const tools = ["backend_info", "staging_sync", "staging_status", "bp_read", "bp_compile_report", "bp_game_test"];
  await withBackend({ tools }, async ({ backend }) => {
    const e = await rejectsWith(backend.info(), "ABFC4001");
    assert.match(e.diagnostic.message, /bp_apply/);
    assert.match(e.diagnostic.message, /C:\\fake\\server/);
    assert.equal(e.exitCode, 2);
  });
});

test("stage and stageStatus", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const rep = await backend.stage("C:\\mods\\TestMod", { discardChanges: true });
    assert.deepEqual(rep, { mod: "TestMod", files: 7, stagingPath: "C:\\fake\\stage\\TestMod" });
    assert.deepEqual(calls()[0], { tool: "staging_sync", args: { mod_dir: "C:\\mods\\TestMod", discard_changes: true } });
    const st = await backend.stageStatus("TestMod");
    assert.deepEqual(st, {
      mod: "TestMod",
      stagingPath: "C:\\fake\\stage\\TestMod",
      syncedAt: "2026-01-02T03:04:05Z",
      changed: ["Content/A.uasset"],
      added: [],
      removed: ["Content/B.uasset"],
      conflicts: [],
    });
  });
});

test("stageStatus: 'not staged' is null, any other tool error is ABFC4002", async () => {
  await withBackend({}, async ({ backend }) => {
    assert.equal(await backend.stageStatus("ghost"), null);
    const e = await rejectsWith(backend.stageStatus("broken"), "ABFC4002");
    assert.match(e.diagnostic.message, /staging_status/);
    assert.match(e.diagnostic.message, /disk on fire/);
  });
});

test("read maps the export path and seconds", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const snap = await backend.read("TestMod", "/TestMod/BP_A");
    assert.equal(snap.asset, "/TestMod/BP_A");
    assert.equal(snap.run, "C:\\fake\\runs\\read-1");
    assert.equal(snap.exportPath, "C:\\fake\\runs\\read-1\\export.t3d");
    assert.equal(snap.seconds, 4.2);
    assert.deepEqual(calls()[0]?.args, { mod: "TestMod", asset_path: "/TestMod/BP_A", include_pins: false, timeout_seconds: 300 });
  });
});

test("applySpecs: writes the spec file and maps a successful result", async () => {
  await withBackend({}, async ({ backend, dir, calls }) => {
    const cacheDir = join(dir, "cache");
    const res = await backend.applySpecs("TestMod", [{ asset: "/TestMod/BP_A" }], { label: "unit one", cacheDir });
    assert.equal(res.ok, true);
    assert.equal(res.rolledBack, false);
    assert.equal(res.run, "C:\\fake\\runs\\apply-1");
    assert.equal(res.seconds, 9.25);
    assert.deepEqual(res.assets, [
      { asset: "/TestMod/BP_A", node_ids: { EventGraph: { ev: "K2Node_CustomEvent_0" } }, final: "final_0.t3d" },
    ]);
    assert.deepEqual(res.compile.warnings, [{ asset: "/TestMod/BP_A", message: "careful" }]);
    const files = readdirSync(cacheDir);
    assert.deepEqual(files, ["apply-20260102-030405-unit_one.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(cacheDir, files[0]!), "utf8")), [{ asset: "/TestMod/BP_A" }]);
    const args = calls()[0]?.args;
    assert.equal(args?.mod, "TestMod");
    assert.equal(args?.timeout_seconds, 600);
    assert.equal(args?.keep_on_error, false);
    assert.equal(args?.spec_file, join(cacheDir, files[0]!));
  });
});

test("applySpecs: a compile failure is a result with rolledBack, compile entries and node refs", async () => {
  await withBackend({}, async ({ backend, dir }) => {
    const res = await backend.applySpecs("failmod", [], { label: "x", cacheDir: dir, keepOnError: true });
    assert.equal(res.ok, false);
    assert.equal(res.rolledBack, true);
    assert.equal(res.assets, null);
    assert.equal(res.error, "2 compile error(s) in the edited assets");
    assert.equal(res.logTail, "tail line");
    assert.deepEqual(res.compile.errors, [
      { asset: "/TestMod/BP_A", message: "Bad pin", node: "K2Node_CallFunction_3", graph: "EventGraph" },
      { asset: "/TestMod/BP_A", message: "Plain error" },
    ]);
  });
});

test("applySpecs: invalid spec is a result; memory-swap refusal is ABFC4100; a traceback is ABFC4002", async () => {
  await withBackend({}, async ({ backend, dir }) => {
    const bad = await backend.applySpecs("badspec", [], { label: "x", cacheDir: dir });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /invalid spec: .*missing asset/);
    const e = await rejectsWith(backend.applySpecs("memswap", [], { label: "x", cacheDir: dir }), "ABFC4100");
    assert.match(e.diagnostic.message, /Nodes array not found/);
    assert.match(e.diagnostic.message, /apply-1/);
    const c = await rejectsWith(backend.applySpecs("crash", [], { label: "x", cacheDir: dir }), "ABFC4002");
    assert.match(c.diagnostic.message, /kaboom/);
  });
});

test("compile maps messages with node refs (null node/graph are omitted)", async () => {
  await withBackend({}, async ({ backend }) => {
    const rep = await backend.compile("TestMod", ["/TestMod/BP_A"]);
    assert.equal(rep.clean, false);
    assert.equal(rep.run, "C:\\fake\\runs\\compile-1");
    assert.equal(rep.seconds, 6);
    assert.deepEqual(rep.messages, [
      { severity: "error", asset: "/TestMod/BP_A", message: "Bad pin", node: "K2Node_CallFunction_3", graph: "EventGraph" },
      { severity: "warning", asset: "/TestMod/BP_A", message: "careful" },
    ]);
  });
});

test("reflect reads the result file (BOM tolerated) and maps the filter", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const res = await backend.reflect({ mod: "TestMod", classes: ["/Script/Fake.Widget"], structs: [], castTargets: ["/Script/Fake.Other"] });
    assert.equal(res.run, "C:\\fake\\runs\\reflect-1");
    assert.equal(res.seconds, 40.5);
    assert.equal(res.data.engineVersion, "5.4.4-fake");
    assert.equal(res.data.classes["/Script/Fake.Widget"]?.castPin, "AsWidget");
    assert.deepEqual(res.data.structs, {});
    assert.deepEqual(res.data.errors, ["one member failed"]);
    assert.deepEqual(res.filter, { contentVersion: "v1", rules: [["Allow", "Fake.Widget"], ["Block", "Fake.Widget.Secret"]] });
    assert.deepEqual(calls()[0]?.args, {
      mod: "TestMod",
      classes: ["/Script/Fake.Widget"],
      structs: [],
      cast_targets: ["/Script/Fake.Other"],
      timeout_seconds: 900,
    });
  });
});

test("gameTest returns a failing report as a result", async () => {
  await withBackend({}, async ({ backend }) => {
    const rep = await backend.gameTest("TestMod", [{ op: "python" }], { timeoutSeconds: 120 });
    assert.equal(rep.ok, false);
    assert.equal(rep.passed, 1);
    assert.equal(rep.failed, 1);
    assert.equal(rep.complete, true);
    assert.equal(rep.timedOut, false);
    assert.equal(rep.error, "1 step(s) failed");
    assert.deepEqual(rep.steps[1], { i: 1, op: "assert", ok: false, value: "R=False", error: "expected True" });
    assert.deepEqual(rep.steps[0], { i: 0, op: "python", ok: true, value: "R=True" });
    assert.deepEqual(rep.runtimeLog, ["LogScript: Warning: something"]);
  });
});

test("audit", async () => {
  await withBackend({}, async ({ backend }) => {
    const rep = await backend.audit("TestMod");
    assert.equal(rep.ok, true);
    assert.equal(rep.seconds, 45);
  });
});

test("bp_publish is never callable through the backend client (allowlist), even though the server lists it", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    const info = await backend.info();
    assert.equal(info.capabilities.publish, true); // descriptive only
    assert.ok(!calls().some((c) => c.tool === "bp_publish"));
  });
});

test("warm session: started once before the first commandlet op, results say warm, staging_sync restarts it, close stops it", async () => {
  await withBackend({}, async ({ backend, calls }) => {
    // not wanted (cold): never started
    const cold = await backend.info();
    assert.equal(cold.capabilities.warmSession, true);
    assert.equal(cold.capabilities.stageAudit, true);
    const snap0 = await backend.read("TestMod", "/TestMod/A");
    assert.equal(snap0.warm, false);
    assert.equal(backend.lastWarm, false);
    assert.equal(calls().filter((c) => c.tool === "warm_session").length, 0);
  });
  const dir = mkdtempSync(join(tmpdir(), "abfc-backend-warm-"));
  const logFile = join(dir, "calls.log");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const client = await McpStdioClient.start({
    command: process.execPath,
    args: [FIXTURE],
    cwd: dir,
    env: { ...env, FAKE_LOG: logFile, FAKE_CONFIG: "{}", FAKE_DIR: dir },
    requestTimeoutMs: 10_000,
    closeGraceMs: 5000,
  });
  const backend = new BpApplyBackend(client, { serverDir: "C:\\fake\\server", warm: true });
  const log = (): Call[] => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  const warmCalls = (): string[] => log().filter((c) => c.tool === "warm_session").map((c) => String(c.args.action));
  try {
    await backend.info();
    assert.deepEqual(warmCalls(), [], "not started before the first operation");
    const snap = await backend.read("TestMod", "/TestMod/A");
    assert.deepEqual(warmCalls(), ["start"]);
    assert.equal(snap.warm, true);
    assert.equal(backend.lastWarm, true);
    const report = await backend.compile("TestMod", ["/TestMod/A"]);
    assert.equal(report.warm, true);
    assert.deepEqual(warmCalls(), ["start"], "started once");
    await backend.stage("C:\\mods\\TestMod", { discardChanges: false });
    await backend.read("TestMod", "/TestMod/A");
    assert.deepEqual(warmCalls(), ["start", "start"], "restarted after staging_sync");
    await backend.close();
    assert.deepEqual(warmCalls(), ["start", "start", "stop"], "stopped on close");
  } finally {
    await backend.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
