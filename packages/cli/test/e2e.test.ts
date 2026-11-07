// CLI end-to-end on the step 23 fixture project (a synthetic mod, TestMod) against the in-memory fake backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHir, compileTests, loadProgram, lower, readManifest, readRetired, readSourceMap } from "@abfc/compiler";
import { loadProfile, realHost, resolveEnvironment } from "@abfc/env";
import type { Host } from "@abfc/env";
import type { IrModule, IrNode } from "@abfc/ir";
import { newLock, writeLock } from "@abfc/stubgen";
import { main, readRuns } from "../src/index.js";
import type { CliDeps } from "../src/index.js";
import { FakeBackend, RELAY_ASSET, SPARE_NODE } from "./fake-backend.js";
import type { FakeBackendOptions } from "./fake-backend.js";
import { fakeEnvironmentFiles } from "./helpers.js";

const profile = loadProfile();
// compiled to packages/cli/dist/test/ -> packages/compiler/test/fixtures/project
const here = fileURLToPath(new URL("./", import.meta.url));
const fixtureProject = fileURLToPath(new URL("../../../compiler/test/fixtures/project", import.meta.url));

const key = (p: string): string => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

/** The fake machine for everything outside `roots`; the real file system below them (the project and the fake run folders). */
function hybridHost(fake: Host, roots: string[]): Host {
  const real = realHost();
  const keys = roots.map(key);
  const isReal = (p: string): boolean => keys.some((r) => key(p) === r || key(p).startsWith(r + "\\"));
  return {
    ...fake,
    exists: (p) => (isReal(p) ? real.exists(p) : fake.exists(p)),
    readFile: (p) => (isReal(p) ? real.readFile(p) : fake.readFile(p)),
    readDir: (p) => (isReal(p) ? real.readDir(p) : fake.readDir(p)),
    stat: (p) => (isReal(p) ? real.stat(p) : fake.stat(p)),
  };
}

const MATCHER = /^(.*\.ts):(\d+):(\d+): (error|warning) (ABFC\d+): (.*)$/;

/** Every diagnostic line is either `abfc: <severity> <code>: ...` or the problem-matcher form. */
function assertMatcherLines(text: string): void {
  for (const l of text.split("\n")) {
    if (!/\b(error|warning) ABFC\d+: /.test(l)) continue;
    if (/^abfc: (error|warning) ABFC\d+: /.test(l)) continue;
    assert.match(l, MATCHER, `not in problem-matcher form: ${l}`);
  }
}

interface Run {
  code: number;
  out: string;
}

interface Rig {
  dir: string;
  backend: FakeBackend;
  started: { count: number; cold: boolean[] };
  run(argv: string[], extra?: Partial<CliDeps>): Promise<Run>;
  lockFile: string;
}

async function withRig(o: FakeBackendOptions, fn: (r: Rig) => Promise<void>): Promise<void> {
  // inside the package tree so that `@abfc/runtime` still resolves through the workspace node_modules
  const dir = mkdtempSync(join(here, "e2e-"));
  const backend = new FakeBackend(o);
  try {
    cpSync(fixtureProject, dir, { recursive: true });
    rmSync(join(dir, "src", "Bad.ts"));
    writeFileSync(
      join(dir, "abf.config.json"),
      JSON.stringify({ mod: { name: "TestMod" }, backend: { kind: "bp_apply", minProtocol: 1 } }),
      "utf8",
    );
    const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
    const host = hybridHost(fake.host(), [dir, backend.root]);
    const env = resolveEnvironment(host, { projectDir: dir, flags: {} });
    const lockFile = join(dir, ".abfc", "stubs", profile.id);
    writeLock(
      lockFile,
      newLock({
        profile: profile.id,
        engineVersion: null,
        modEditorVersion: profile.modEditorVersion,
        editorFingerprint: env.fingerprint ?? "",
        filterContentVersion: null,
        classes: [],
        scriptClasses: [],
        modAssets: [],
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    const started = { count: 0, cold: [] as boolean[] };
    const run = async (argv: string[], extra: Partial<CliDeps> = {}): Promise<Run> => {
      const lines: string[] = [];
      const deps: CliDeps = {
        host,
        startBackend: async (_env, o) => {
          started.count++;
          started.cold.push(o?.cold === true);
          return backend;
        },
        now: () => new Date(2026, 0, 2, 3, 4, 5),
        cwd: dir,
        stdout: (l) => lines.push(l),
        stderr: (l) => lines.push(l),
        ...extra,
      };
      const code = await main(argv, deps);
      const out = lines.join("\n");
      assertMatcherLines(out);
      return { code, out };
    };
    await fn({ dir, backend, started, run, lockFile });
  } finally {
    backend.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

function lowerProject(dir: string): IrModule {
  const hir = buildHir(loadProgram(dir), { mod: "TestMod" }, profile);
  assert.deepEqual(hir.diagnostics, []);
  return lower(hir, profile);
}

function irNode(ir: IrModule, fn: string): IrNode {
  const n = ir.assets[0]!.units[0]!.nodes.find((x) => x.sem?.k === "call" && x.sem.function === fn);
  assert.ok(n, `IR node calling ${fn}`);
  return n;
}

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

test("(a) adopt needs --yes; build on the fallback route writes manifest, hashes, source map and timings; rebuild is up to date", async () => {
  await withRig({}, async (r) => {
    let x = await r.run(["adopt", RELAY_ASSET, "UpdateTarget"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC5006/);
    assert.equal(readManifest(r.dir, RELAY_ASSET), null, "nothing is written without --yes");
    assert.equal(r.backend.applyLabels().length, 0);

    x = await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"]);
    assert.equal(x.code, 0, x.out);
    const adopted = readManifest(r.dir, RELAY_ASSET)!.units[0]!;
    assert.equal(adopted.id, "event:UpdateTarget");
    assert.deepEqual(adopted.adopt?.nodes, ["K2Node_CallFunction_0", "K2Node_CustomEvent_0"]);
    assert.equal(r.backend.applyLabels().length, 0, "adopt never calls bp_apply");

    x = await r.run(["build", "--timings"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4012/);
    assert.match(x.out, /applied UpdateTarget in \/TestMod\/Relay\/BP_Relay \(route: fallback\)/);
    assert.deepEqual(r.backend.applyLabels(), ["main-a", "main-b", "tags"]);
    const applies = r.backend.calls.filter((c) => c.tool === "bp_apply");
    const phaseA = applies[0]!.specs![0]!;
    assert.deepEqual(phaseA.graphs[0].remove, adopted.adopt!.nodes, "the adopted nodes are replaced");
    assert.equal(phaseA.graphs[0].add.length, 52);
    assert.equal(phaseA.graphs[0].wires.length, 74);
    assert.equal(phaseA.graphs[0].add.filter((n: any) => n.pin_types !== undefined).length, 0);
    const phaseB = applies[1]!.specs![0]!;
    assert.equal(phaseB.graphs, undefined);
    assert.equal(phaseB.raw.length, 1);
    assert.equal(countOf(phaseB.raw[0].text, 'PinCategory="wildcard"'), 0);
    assert.equal(phaseB.variables.length, 2);

    const unit = readManifest(r.dir, RELAY_ASSET)!.units[0]!;
    assert.match(unit.assetHash ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.match(unit.irHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(unit.nodes.length, 52);
    assert.equal(Object.keys(unit.nodeIds).length, 52);
    assert.match(unit.tag ?? "", /^EdGraphNode_Comment_\d+$/);
    assert.equal(unit.stageSyncedAt, "sync-1");
    assert.notEqual(unit.adopt, null, "the adoption record is kept");
    assert.deepEqual(readManifest(r.dir, RELAY_ASSET)!.source, { file: "src/Relay.ts", class: "BP_Relay", derived: false }, "the manifest records where the class lives");
    const sm = readSourceMap(r.dir, RELAY_ASSET)!;
    const nodes = Object.values(sm.units["event:UpdateTarget"]!.nodes);
    assert.equal(nodes.length, 52);
    assert.ok(nodes.every((n) => n.real !== null && n.span.line > 0));
    const steps = readRuns(win32.join(r.dir, ".abfc", "runs.jsonl")).map((e) => e.step);
    for (const s of ["build.frontend", "build.stage", "apply.phaseA", "apply.phaseB", "apply.tags", "build.compile", "build.total"]) {
      assert.ok(steps.includes(s), `runs.jsonl has ${s}`);
    }
    assert.match(x.out, /apply\.phaseA/);

    const before = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, before, "a rebuild does not apply");

    x = await r.run(["status"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /BP_Relay event:UpdateTarget clean/);
  });
});

test("(b) an edit of an owned node in the stage stops the build with ABFC5001 and applies nothing", async () => {
  await withRig({}, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    assert.equal((await r.run(["build"])).code, 0);
    const ir = lowerProject(r.dir);
    const real = readManifest(r.dir, RELAY_ASSET)!.units[0]!.nodeIds[irNode(ir, "EqualEqual_DoubleDouble").id];
    assert.ok(real);
    r.backend.setPinDefault(RELAY_ASSET, real, "B", "5.0");

    // nothing changed in TypeScript: the asset is not read, so the build is a no-op (abfc status reads everything)
    const before = r.backend.applyLabels().length;
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, before);

    // once the unit is re-planned the drift is found
    const src = join(r.dir, "src", "Relay.ts");
    writeFileSync(src, readFileSync(src, "utf8").replace("const rowName = Lib.RowToName(pot.Row);", "const rowName = Lib.RowToName(pot.Row); this.LastName = rowName;"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC5001/);
    assert.equal(r.backend.applyLabels().length, before, "no bp_apply after the drift");

    x = await r.run(["status"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /event:UpdateTarget edited/);
  });
});

test("(b1) a build that applies but fails Unreal's compile is repeated by the next unchanged build, and publish --full gate 3 fails on it", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    r.backend.reportMessages = [{ severity: "error", asset: RELAY_ASSET, message: "boom" }];
    let x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /error ABFC6002/);
    const applies = r.backend.applyLabels().length;
    assert.ok(applies > 0);
    const unit = readManifest(r.dir, RELAY_ASSET)!.units[0]!;
    assert.equal(unit.irHash, "", "the IR hash is recorded only after the compile passed");
    assert.ok(unit.nodes.length > 0, "the manifest still describes what is on the stage");

    // nothing changed in TypeScript: the next build re-applies and reports the error again; it is not "up to date"
    x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /up to date/);
    assert.match(x.out, /error ABFC6002/);
    assert.ok(r.backend.applyLabels().length > applies, "the unchanged build applied again");

    // the publish gate stops at gate 3
    x = await r.run(["publish", "--full", "--dry-run"]);
    assert.notEqual(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /would publish/);
    const gates = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step === "gate.3");
    assert.equal(gates[gates.length - 1]!.ok, false);

    // the fast publish stops at the build too
    x = await r.run(["publish"]);
    assert.notEqual(x.code, 0, x.out);
    assert.equal(r.backend.publishCalls.length, 0);

    // once Unreal compiles it clean the hash is recorded and the build is up to date
    r.backend.reportMessages = [];
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(readManifest(r.dir, RELAY_ASSET)!.units[0]!.irHash, /^sha256:[0-9a-f]{64}$/);
    const after = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, after);
  });
});

test("(b3) publish --full gate 3 reads every owned asset: an editor edit of an unchanged unit fails with ABFC5001 and nothing is applied", async () => {
  await withRig({}, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    assert.equal((await r.run(["build"])).code, 0);
    const ir = lowerProject(r.dir);
    const real = readManifest(r.dir, RELAY_ASSET)!.units[0]!.nodeIds[irNode(ir, "EqualEqual_DoubleDouble").id];
    assert.ok(real);
    r.backend.setPinDefault(RELAY_ASSET, real, "B", "5.0");

    const before = r.backend.applyLabels().length;
    assert.equal((await r.run(["build"])).code, 0, "an unchanged build does not read the asset");
    const x = await r.run(["publish", "--full", "--dry-run"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC5001/);
    assert.doesNotMatch(x.out, /would publish/);
    assert.equal(r.backend.applyLabels().length, before, "no bp_apply after the drift");
    const gates = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step === "gate.3");
    assert.equal(gates[gates.length - 1]!.ok, false);
  });
});

test("(b2) adopting a unit abfc already applied is refused (ABFC5007) unless --discard-editor-changes; then the old nodes and tag are removed", async () => {
  await withRig({}, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    assert.equal((await r.run(["build"])).code, 0);
    const applied = readManifest(r.dir, RELAY_ASSET)!;
    const oldUnit = applied.units[0]!;
    assert.equal(oldUnit.nodes.length, 52);
    assert.ok(oldUnit.tag);
    const ir = lowerProject(r.dir);
    r.backend.setPinDefault(RELAY_ASSET, oldUnit.nodeIds[irNode(ir, "EqualEqual_DoubleDouble").id]!, "B", "5.0");

    const before = r.backend.calls.filter((c) => c.tool === "bp_apply").length;
    for (const argv of [["adopt", RELAY_ASSET, "UpdateTarget"], ["adopt", RELAY_ASSET, "UpdateTarget", "--yes"]]) {
      const x = await r.run(argv);
      assert.equal(x.code, 3, x.out);
      assert.match(x.out, /error ABFC5007/);
      assert.match(x.out, /--discard-editor-changes/);
      assert.deepEqual(readManifest(r.dir, RELAY_ASSET), applied, "the manifest is unchanged");
      assert.equal(r.backend.calls.filter((c) => c.tool === "bp_apply").length, before, "adopt never applies");
    }

    // without --yes the flag alone still writes nothing
    let x = await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--discard-editor-changes"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC5006/);
    assert.deepEqual(readManifest(r.dir, RELAY_ASSET), applied);

    x = await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes", "--discard-editor-changes"]);
    assert.equal(x.code, 0, x.out);
    const re = readManifest(r.dir, RELAY_ASSET)!.units[0]!;
    assert.equal(re.stageSyncedAt, null);
    assert.deepEqual(re.nodes, []);
    assert.equal(re.tag, null);
    const removal = re.adopt!.nodes;
    assert.ok(removal.includes(oldUnit.tag!), "the old ownership comment is removed");
    for (const n of oldUnit.nodes) assert.ok(removal.includes(n), `old node ${n} is removed`);
    assert.equal(new Set(removal).size, removal.length);
    assert.equal(r.backend.calls.filter((c) => c.tool === "bp_apply").length, before, "adopt never applies");

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const apply = r.backend.calls.filter((c) => c.tool === "bp_apply")[before]!.specs![0]!;
    assert.deepEqual([...apply.graphs[0].remove].sort(), [...removal].sort());
    const rebuilt = readManifest(r.dir, RELAY_ASSET)!.units[0]!;
    assert.equal(rebuilt.nodes.length, 52);
    assert.equal(r.backend.nodeNames(RELAY_ASSET).filter((n) => n.startsWith("EdGraphNode_Comment_")).length, 1, "one ownership comment");
  });
});

test("(c) an Unreal compile error on the name comparison maps to its TypeScript expression", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    const ir = lowerProject(r.dir);
    const node = irNode(ir, "EqualEqual_NameName");
    const sourceLine = readFileSync(join(r.dir, "src", "Relay.ts"), "utf8").split(/\r?\n/)[node.origin.line - 1];
    assert.ok(sourceLine?.includes("rowName === this.LastName"), sourceLine);
    r.backend.compileError = { irId: node.id, message: "The pins cannot be compared" };

    let x = await r.run(["build"]);
    assert.equal(x.code, 1, x.out);
    const expected = `src/Relay.ts:${node.origin.line}:${node.origin.col}: error ABFC6001: [Unreal] The pins cannot be compared`;
    assert.ok(x.out.split("\n").includes(expected), `${expected}\n--- got ---\n${x.out}`);
    const errs = x.out.split("\n").filter((l) => /error ABFC\d+/.test(l));
    assert.equal(errs.length, 1, x.out);
    assert.deepEqual(r.backend.applyLabels(), ["main-a"], "phase B is not tried after a real compile error");
    assert.equal(readManifest(r.dir, RELAY_ASSET), null, "the manifest is untouched");
    assert.equal(r.backend.nodeNames(RELAY_ASSET).length, 2, "the stage was rolled back");

    r.backend.compileError = null;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
  });
});

test("(d) a changed editor fingerprint: build exits 2 with ABFC3001, check warns and exits 0", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    const file = join(r.lockFile, "stubs.lock.json");
    const lock = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    lock.editorFingerprint = "0".repeat(64);
    writeFileSync(file, JSON.stringify(lock), "utf8");

    let x = await r.run(["build"]);
    assert.equal(x.code, 2, x.out);
    assert.match(x.out, /error ABFC3001/);
    assert.equal(r.started.count, 0, "the backend is not started");
    assert.equal(r.backend.applyLabels().length, 0);

    x = await r.run(["check"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC3001/);
    assert.doesNotMatch(x.out, /error ABFC/);
    assert.match(x.out, /checked 1 unit\(s\) in 1 asset\(s\), 2 test\(s\): no errors/);
  });
});

test("(e) tests: a known-issue failure passes with ABFC6102, a real failure is ABFC6101 at the t.expect span", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const cases = compileTests(loadProgram(r.dir), profile).cases;
    assert.equal(cases.length, 2);
    const known = cases.map((c) => c.steps.flatMap((s, i) => (s.knownIssue !== undefined ? [i] : [])));
    assert.ok(known.some((k) => k.length > 0), "the fixture has known-issue steps");

    r.backend.gameTestFailures = known;
    r.backend.gameTestCalls = 0;
    let x = await r.run(["test", "--no-build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /PASS update target clears without a pot/);
    assert.match(x.out, /PASS assertion forms/);
    assert.match(x.out, /warning ABFC6102/);
    assert.match(x.out, /2 of 2 test\(s\) passed/);

    const at = cases[0]!.steps.findIndex((s) => "equals" in s.step);
    assert.ok(at >= 0);
    const span = cases[0]!.steps[at]!.span;
    r.backend.gameTestFailures = [[at], []];
    r.backend.gameTestCalls = 0;
    x = await r.run(["test", "--no-build"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /FAIL update target clears without a pot/);
    assert.ok(
      x.out.split("\n").some((l) => l.startsWith(`src/Relay.test.ts:${span.line}:${span.col}: error ABFC6101: `)),
      x.out,
    );
    assert.match(x.out, /1 of 2 test\(s\) passed/);
  });
});

test("(f) publish (fast) builds, copies the owned assets with a grant for the project's mod, and skips tests, audit and upload check", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    r.backend.extraChanged = ["Content/Other/BP_NotMine.uasset"];
    const x = await r.run(["publish", "--timings"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.publishCalls.length, 1);
    const call = r.backend.publishCalls[0]!;
    assert.equal(call.mod, "TestMod");
    assert.deepEqual(call.assets, ["/TestMod/Relay/BP_Relay"]);
    assert.equal(call.grant.mod, "TestMod");
    assert.match(x.out, /published:/);
    assert.match(x.out, /backup: backups\/fake/);
    assert.match(x.out, /publish\.copy/);
    assert.ok(!r.backend.tools().includes("mod_audit"));
    assert.ok(!r.backend.tools().includes("bp_game_test"));
    const steps = readRuns(join(r.dir, ".abfc", "runs.jsonl")).map((e) => e.step);
    assert.ok(!steps.some((s) => s.startsWith("gate.")));
    for (const s of ["publish.list", "publish.copy", "publish.total"]) assert.ok(steps.includes(s), s);
  });
});

test("(f2) publish --full: success passes seven gates, lists only owned assets, times each gate, never calls bp_publish", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    r.backend.extraChanged = ["Content/Other/BP_NotMine.uasset", "Binaries/x.dll"];
    const x = await r.run(["publish", "--full", "--dry-run"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC7003/, "the stage is audited, no warning");
    assert.match(x.out, /changed Content\/Relay\/BP_Relay\.uasset/);
    assert.doesNotMatch(x.out, /BP_NotMine|x\.dll|_McpTmp/);
    const gates = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step.startsWith("gate."));
    assert.deepEqual(gates.map((e) => e.step), ["gate.1", "gate.2", "gate.3", "gate.4", "gate.5", "gate.6", "gate.7"]);
    assert.ok(gates.every((e) => e.ok));
    assert.ok(!r.backend.tools().includes("bp_publish"));
    assert.ok(r.backend.tools().includes("mod_audit"));
  });
});

test("(f3) publish gate 1: a stale stub fingerprint stops before the backend starts", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    const lock = JSON.parse(readFileSync(join(r.lockFile, "stubs.lock.json"), "utf8")) as Record<string, unknown>;
    lock.editorFingerprint = "0".repeat(64);
    writeFileSync(join(r.lockFile, "stubs.lock.json"), JSON.stringify(lock), "utf8");
    const x = await r.run(["publish", "--full", "--dry-run"]);
    assert.equal(x.code, 2, x.out);
    assert.match(x.out, /error ABFC3001/);
    assert.equal(r.started.count, 0);
    const gates = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step.startsWith("gate."));
    assert.deepEqual(gates.map((e) => [e.step, e.ok]), [["gate.1", false]]);

    const fast = await r.run(["publish", "--dry-run"]);
    assert.equal(fast.code, 2, fast.out);
    assert.match(fast.out, /error ABFC3001/);
    assert.equal(r.started.count, 0);
  });
});

test("(f4) publish gate 4: a failing test stops before the audit", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const cases = compileTests(loadProgram(r.dir), profile).cases;
    const at = cases[0]!.steps.findIndex((s) => "equals" in s.step);
    assert.ok(at >= 0);
    r.backend.gameTestFailures = [[at], []];
    const x = await r.run(["publish", "--full", "--dry-run"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC6101/);
    assert.doesNotMatch(x.out, /would publish/);
    assert.ok(!r.backend.tools().includes("mod_audit"));
  });
});

test("(f5) publish gate 5: audit not passed is ABFC7002 with the reason; the real-mod audit is a warning; a wrong copy fails", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    r.backend.auditOk = false;
    r.backend.auditRaw = { ok: false, error: "the picker lists two mods" };
    let x = await r.run(["publish", "--full", "--dry-run"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC7002: .*the picker lists two mods/);
    assert.doesNotMatch(x.out, /would publish/);

    r.backend.auditOk = true;
    r.backend.auditRaw = { ok: true, audited_copy: "mod" };
    x = await r.run(["publish", "--full", "--dry-run"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC7002: .*audited the mod copy/);
  });
  await withRig({ handMadeEvent: false }, async (r) => {
    const x = await r.run(["publish", "--full", "--dry-run"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC7003/);
  });
});

test("(f6) publish gate 6: a .md file in the mod or the stage folder is ABFC7010 and stops the publish", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    const listFiles = (root: string) => [
      { rel: "Content/Relay/BP_Relay.uasset", size: 10 },
      { rel: root.includes("abfc-fake-backend-") ? "Notes/CHANGES.md" : "README.md", size: 5 },
      { rel: "Content/Relay/readme.txt", size: 1 },
    ];
    const x = await r.run(["publish", "--full", "--dry-run"], { listFiles });
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC7010: mod folder: README\.md/);
    assert.match(x.out, /error ABFC7010: stage folder: Notes\/CHANGES\.md/);
    assert.match(x.out, /warning ABFC7012: .*readme\.txt/);
    assert.doesNotMatch(x.out, /would publish/);
    const gates = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step.startsWith("gate."));
    assert.equal(gates.at(-1)?.step, "gate.6");
    assert.equal(gates.at(-1)?.ok, false);
  });
});

test("(f7) publish --dry-run (fast) lists and never sends bp_publish", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    const x = await r.run(["publish", "--dry-run"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /would publish:/);
    assert.match(x.out, /changed Content\/Relay\/BP_Relay\.uasset/);
    assert.equal(r.backend.publishCalls.length, 0);
    assert.ok(!r.backend.tools().includes("bp_publish"));
    assert.ok(!r.backend.tools().includes("mod_audit"));
  });
});

test("(f8) publish --full runs gates 1-8 and copies", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    const x = await r.run(["publish", "--full"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.publishCalls.length, 1);
    assert.equal(r.backend.publishCalls[0]!.mod, "TestMod");
    assert.ok(r.backend.tools().includes("mod_audit"));
    assert.match(x.out, /published:/);
    const gates = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step.startsWith("gate."));
    assert.deepEqual(gates.map((e) => e.step), ["gate.1", "gate.2", "gate.3", "gate.4", "gate.5", "gate.6", "gate.7", "gate.8"]);
    assert.ok(gates.every((e) => e.ok));
  });
});

test("(f9) a refusal of bp_publish becomes a diagnostic with a specific fix and exit code", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    const base = r.backend.publishResult;
    const refuse = async (patch: Partial<typeof base>): Promise<Run> => {
      r.backend.publishResult = { ...base, ok: false, published: [], ...patch };
      const x = await r.run(["publish"]);
      const steps = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step === "publish.copy");
      assert.equal(steps.at(-1)?.ok, false, "the publish step failed");
      return x;
    };

    let x = await refuse({
      refused: "compile errors",
      message: "Refused: 1 compile error",
      compileErrors: [{ asset: "/TestMod/Relay/BP_Relay", message: "bad pin" }],
    });
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC7004/);
    assert.match(x.out, /bad pin/);

    x = await refuse({
      refused: "editor refused",
      editorReason: "Play In Editor is running",
      message: "Refused by the open editor: x (Play In Editor is running). Stop Play In Editor, then publish again. Nothing was copied.",
    });
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC7005/);
    assert.match(x.out, /stop Play In Editor/);

    x = await refuse({
      refused: "editor refused",
      editorReason: "modified assets (unsaved changes)",
      message: "Refused by the open editor: x (modified assets (unsaved changes)). Save or revert those assets, then publish again. Nothing was copied.",
    });
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /save or revert/);
    assert.doesNotMatch(x.out, /stop Play In Editor/);

    x = await refuse({
      refused: "editor refused",
      editorReason:
        "unload incomplete (packages still loaded); asset editors of these packages may have been closed and the unloaded ones were loaded back. Nothing was copied.",
      message:
        "Refused by the open editor: /TestMod/A/BP_A, /TestMod/A/BP_B (unload incomplete (packages still loaded); asset editors of these packages may have been closed and the unloaded ones were loaded back. Nothing was copied.). Save or close those assets, stop Play In Editor, then publish again. Nothing was copied.",
    });
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /ABFC7005/);
    assert.match(x.out, /Update the backend/);
    assert.doesNotMatch(x.out, /stop Play In Editor in the Mod Editor/);

    x = await refuse({
      refused: "file locked",
      editor: "open",
      message: "Refused: Content/A/BP_A.uasset is still held by the open editor after it released the assets.",
    });
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /close the asset editor tabs/);

    x = await refuse({
      refused: "conflicts",
      message: "Refused: the real mod changed",
      conflicts: ["Content/Relay/BP_Relay.uasset: changed"],
    });
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /abfc build --resync/);

    x = await refuse({ refused: "editor unreachable", message: "The editor did not answer" });
    assert.equal(x.code, 2, x.out);
    assert.match(x.out, /error ABFC7006/);

    x = await refuse({ refused: "copy failed", message: "Copy failed", restored: false, backup: "B1" });
    assert.equal(x.code, 2, x.out);
    assert.match(x.out, /copy the listed files back from B1/);
  });
});

test("(f10) nothing staged: no bp_publish call, exit 0 (fast and --full)", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    r.backend.hideChanged = true;
    for (const argv of [["publish"], ["publish", "--full"]]) {
      const x = await r.run(argv);
      assert.equal(x.code, 0, x.out);
      assert.match(x.out, /nothing to publish\./);
    }
    assert.equal(r.backend.publishCalls.length, 0);
  });
});

test("(f11) publish --full --dry-run never sends bp_publish", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    const x = await r.run(["publish", "--full", "--dry-run"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /would publish:/);
    assert.equal(r.backend.publishCalls.length, 0);
    assert.ok(!r.backend.tools().includes("bp_publish"));
  });
});

test("(f12) a failing test stops --full before bp_publish, while fast publish ignores tests", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const cases = compileTests(loadProgram(r.dir), profile).cases;
    const at = cases[0]!.steps.findIndex((s) => "equals" in s.step);
    assert.ok(at >= 0);
    r.backend.gameTestFailures = [[at], []];
    let x = await r.run(["publish", "--full"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC6101/);
    assert.equal(r.backend.publishCalls.length, 0);

    r.backend.gameTestFailures = [];
    r.backend.hideChanged = false;
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.publishCalls.length, 1);
  });
});

test("(f13) a build error stops fast publish", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    r.backend.reportMessages = [{ severity: "error", asset: RELAY_ASSET, message: "boom" }];
    const x = await r.run(["publish"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC6002/);
    assert.equal(r.backend.publishCalls.length, 0);
  });
});

test("(f14) a live-reload publish names the closed tabs and the assets left modified", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    const base = r.backend.publishResult;
    assert.ok(base.published.length > 0, "base result publishes something");
    r.backend.publishResult = {
      ...base,
      route: "live-reload",
      editor: "open",
      reloadedInPlace: ["/TestMod/A/BP_A"],
      dirtyAfter: ["/TestMod/Data/Row_A"],
    };
    const x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /reloaded the published assets in place/);
    assert.match(x.out, /Row_A/);
  });
});

test("(f15) a live-reload publish names the reloaded referencers and warns about editor compile errors", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    const base = r.backend.publishResult;
    r.backend.publishResult = {
      ...base,
      route: "live-reload",
      editor: "open",
      reloadedReferencers: ["/TestMod/A/BP_Ref"],
      compileErrorsAfter: [{ asset: "/TestMod/A/BP_Ref", message: "cannot connect to the new class" }],
    };
    const x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /BP_Ref/);
    assert.match(x.out, /ABFC7013/);
    assert.match(x.out, /compile them again, or restart the Mod Editor/);
    assert.match(x.out, /cannot connect to the new class/);
  });
});

test("(f16) a live-reload publish names the referencers left unreloaded and the published assets whose edits were discarded", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    const base = r.backend.publishResult;
    r.backend.publishResult = {
      ...base,
      route: "live-reload",
      editor: "open",
      skippedDirty: ["/TestMod/A/BP_Edited"],
      dirtyPublished: ["/TestMod/A/BP_Lost"],
    };
    const x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /NOT reloaded/);
    assert.match(x.out, /BP_Edited/);
    assert.match(x.out, /unsaved edits were discarded/);
    assert.match(x.out, /BP_Lost/);
  });
});

test("(g) a stage resync replays the adoption: the hand-made nodes are removed again", async () => {
  await withRig({}, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    assert.equal((await r.run(["build"])).code, 0);
    assert.equal(readManifest(r.dir, RELAY_ASSET)!.units[0]!.stageSyncedAt, "sync-1");
    const first = r.backend.applyLabels().length;

    const x = await r.run(["build", "--resync"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.backend.applyLabels().slice(first), ["main-a", "main-b", "tags"]);
    const again = r.backend.calls.filter((c) => c.tool === "bp_apply")[first]!.specs![0]!;
    assert.deepEqual(again.graphs[0].remove, ["K2Node_CallFunction_0", "K2Node_CustomEvent_0"]);
    assert.equal(r.backend.tools().filter((t) => t === "staging_sync").length, 2);
    assert.equal(readManifest(r.dir, RELAY_ASSET)!.units[0]!.stageSyncedAt, "sync-2");
    assert.equal(r.backend.nodeNames(RELAY_ASSET).filter((n) => n.startsWith("K2Node_CustomEvent_")).length, 2, "OtherEvent and the new UpdateTarget");
  });
});

test("(g2) a stage re-synced from a published mod that holds the built graphs: resync applies nothing, the manifests take the new sync time, status is clean", async () => {
  await withRig({}, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    assert.equal((await r.run(["build"])).code, 0);
    assert.equal(readManifest(r.dir, RELAY_ASSET)!.units[0]!.stageSyncedAt, "sync-1");
    const first = r.backend.applyLabels().length;
    const nodesBefore = r.backend.nodeNames(RELAY_ASSET).join(",");

    r.backend.keepAssetsOnSync = true;
    const x = await r.run(["build", "--resync"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, first, "nothing is re-applied");
    assert.equal(r.backend.nodeNames(RELAY_ASSET).join(","), nodesBefore);
    assert.equal(readManifest(r.dir, RELAY_ASSET)!.units[0]!.stageSyncedAt, "sync-2");

    const st = await r.run(["status"]);
    assert.equal(st.code, 0, st.out);
    assert.match(st.out, /UpdateTarget clean/);
    assert.doesNotMatch(st.out, /ABFC50/);
  });
});

test("(h) native pin types: one main bp_apply call, no phase B, no pin_types on casts; doctor says native", async () => {
  await withRig({ backendInfo: true, handMadeEvent: false }, async (r) => {
    let x = await r.run(["doctor"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /wildcard pin types: native/);

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC4012/);
    assert.match(x.out, /\(route: native\)/);
    assert.deepEqual(r.backend.applyLabels(), ["main", "tags"]);
    const main0 = r.backend.calls.find((c) => c.label === "main")!.specs![0]!;
    const nodes: Array<Record<string, any>> = main0.graphs[0].add;
    assert.equal(nodes.filter((n) => n.k === "cast").length, 2);
    assert.equal(nodes.filter((n) => n.k === "cast" && n.pin_types !== undefined).length, 0);
    assert.equal(nodes.filter((n) => n.pin_types !== undefined).length, 3);
    assert.equal(r.backend.tools().filter((t) => t === "backend_info").length >= 1, true);
  });
});

test("adopt --remove-node: an unknown node is ABFC5008, an override that is not in the graph is ABFC5002; nothing is written", async () => {
  await withRig({}, async (r) => {
    let x = await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--remove-node", "NoSuchNode", "--yes"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC5008/);
    x = await r.run(["adopt", RELAY_ASSET, "override:ReceiveTick", "--yes"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC5002/);
    assert.equal(readManifest(r.dir, RELAY_ASSET), null, "nothing is written when the analysis fails");
    assert.equal(r.backend.applyLabels().length, 0);
  });
});

test("incremental cache: warm runs are recorded, an unchanged asset is not read, a stub lock or compiler change re-plans, --cold reaches the backend", async () => {
  await withRig({}, async (r) => {
    r.backend.warm = true;
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.started.cold.slice(-1), [false]);
    const runs = readRuns(win32.join(r.dir, ".abfc", "runs.jsonl"));
    for (const s of ["build.read", "apply.phaseA", "build.compile"]) {
      assert.equal(runs.find((e) => e.step === s)?.mode, "warm", `${s} ran on the warm session`);
    }
    assert.equal(runs.find((e) => e.step === "build.frontend")?.mode, "cold");

    const cacheFile = join(r.dir, ".abfc", "cache", "units.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, Record<string, Record<string, string>>>;
    const entry = cache[RELAY_ASSET]!["event:UpdateTarget"]!;
    assert.match(entry.irHash ?? "", /^sha256:/);
    assert.equal(entry.compilerVersion, "abfc 0.1.0");

    const reads = (): number => r.backend.tools().filter((t) => t === "bp_read").length;
    const readsBefore = reads();
    const appliesBefore = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date \(1 unit/);
    assert.equal(reads(), readsBefore, "an asset with nothing to plan is not read");
    assert.equal(r.backend.applyLabels().length, appliesBefore);

    // another stub lock: the unit is built again although its IR hash is equal
    entry.stubLockHash = "other";
    writeFileSync(cacheFile, JSON.stringify(cache), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /applied UpdateTarget/);
    assert.ok(r.backend.applyLabels().length > appliesBefore, "re-applied after the stub lock changed");
    const fresh = JSON.parse(readFileSync(cacheFile, "utf8")) as typeof cache;
    assert.notEqual(fresh[RELAY_ASSET]!["event:UpdateTarget"]!.stubLockHash, "other");

    // another compiler version does the same
    fresh[RELAY_ASSET]!["event:UpdateTarget"]!.compilerVersion = "abfc 0.0.1";
    writeFileSync(cacheFile, JSON.stringify(fresh), "utf8");
    const afterStub = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(r.backend.applyLabels().length > afterStub, "re-applied after the compiler changed");

    x = await r.run(["build", "--cold"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.started.cold.slice(-1), [true]);
  });
});

test("a documented event built without event_meta is applied again once the backend gains it", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    const src = join(r.dir, "src", "Relay.ts");
    const text = readFileSync(src, "utf8");
    assert.ok(text.includes("  @event\n  UpdateTarget"));
    writeFileSync(src, text.replace("  @event\n  UpdateTarget", "  /** Updates the target. */\n  @event\n  UpdateTarget"), "utf8");

    // an older backend: applied, ABFC2071 warns, the cache records that no tooltip was written
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /ABFC2071/);
    const cacheFile = join(r.dir, ".abfc", "cache", "units.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, Record<string, { eventMeta?: boolean }>>;
    assert.equal(cache[RELAY_ASSET]!["event:UpdateTarget"]!.eventMeta, false);

    const before = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, before, "unchanged while the backend stays old");

    // the backend is updated: the unit is applied again with its tooltip, the warning is gone, the next build is up to date
    r.backend.setEventMeta(true);
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC2071/);
    assert.match(x.out, /applied UpdateTarget/);
    assert.ok(r.backend.applyLabels().length > before, "re-applied once the backend has event_meta");
    const fresh = JSON.parse(readFileSync(cacheFile, "utf8")) as typeof cache;
    assert.equal(fresh[RELAY_ASSET]!["event:UpdateTarget"]!.eventMeta, true);
    const after = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, after);
  });
});

test("an undocumented event keeps its cache entry and is not re-applied when the backend gains event_meta", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const cacheFile = join(r.dir, ".abfc", "cache", "units.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, Record<string, { eventMeta?: boolean }>>;
    assert.equal("eventMeta" in cache[RELAY_ASSET]!["event:UpdateTarget"]!, false);
    const before = r.backend.applyLabels().length;
    r.backend.setEventMeta(true);
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, before);
  });
});

const PHASE2_RELAY = `import { blueprint, event, override } from "@abfc/runtime";
import type { double } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import { FakeSystem } from "/Script/FakeGame";
import type { BP_Relay_Manual } from "/TestMod/Relay/BP_Relay";

export interface BP_Relay extends BP_Relay_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Relay", replicates: true, netUpdateFrequency: 2, tickInterval: 0.1 })
export class BP_Relay extends Actor {
  @override
  override ReceiveTick(Delta: double): void {
    this.Scan();
  }

  @event
  UpdateTarget(): void {
    this.HideAll();
  }

  @event
  OtherEvent(): void {
    this.Visible = false;
  }

  @event
  Start(): void {
    FakeSystem.SetTimerThing(this.Scan, 1.0);
  }

  @event
  Scan(): void {
    this.Visible = false;
  }
}
`;

/** The project of the Phase 2 cases: a Relay with an override, a delegate and class options; the fake stubs get the matching members. */
function writePhase2Project(dir: string): void {
  writeFileSync(join(dir, "src", "Relay.ts"), PHASE2_RELAY, "utf8");
  const engine = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
  writeFileSync(
    engine,
    readFileSync(engine, "utf8").replace(
      "export declare class Actor extends UObject {}",
      `export declare class Actor extends UObject {
  /**
   * @bpPath /Script/FakeEngine.Actor:ReceiveTick
   * @bpParam DeltaSeconds double
   */
  ReceiveTick(DeltaSeconds: double): void;
}`,
    ).replace(/^(import [^\n]*\n)/, '$1import type { double } from "@abfc/runtime";\n'),
    "utf8",
  );
  const game = join(dir, ".abfc", "stubs", "test", "Script", "FakeGame.d.ts");
  writeFileSync(
    game,
    `${readFileSync(game, "utf8")}
import type { DelegateRef } from "@abfc/runtime";

/**
 * @bpPath /Script/FakeGame.FakeSystem
 * @bpMeta /Script/CoreUObject.Class
 */
export declare namespace FakeSystem {
  /**
   * @bpPath /Script/FakeGame.FakeSystem:SetTimerThing
   * @bpParam Callback unsupported:delegate
   * @bpParam Time float
   * @bpUnsupported delegate
   */
  function SetTimerThing(Callback: DelegateRef, Time: float): void;
}
`,
    "utf8",
  );
}

/** Names of the \`event\` nodes and the number of \`override\` nodes that the main \`bp_apply\` specs of the calls from \`from\` on add. */
function appliedUnits(b: FakeBackend, from: number): { events: string[]; overrides: number; wires: string[][]; ids: Record<string, string> } {
  const events: string[] = [];
  const ids: Record<string, string> = {};
  const wires: string[][] = [];
  let overrides = 0;
  for (const c of b.calls.slice(from)) {
    if (c.tool !== "bp_apply" || !(c.label ?? "").startsWith("main")) continue;
    for (const spec of c.specs ?? []) {
      for (const g of (spec.graphs ?? []) as Array<{ add: Array<{ id: string; k: string; name?: string }>; wires?: string[][] }>) {
        for (const n of g.add) {
          if (n.k === "event" && n.name !== undefined) {
            events.push(n.name);
            ids[n.name] = n.id;
          }
          if (n.k === "override") overrides++;
        }
        wires.push(...(g.wires ?? []));
      }
    }
  }
  return { events: events.sort(), overrides, wires, ids };
}

test("phase 2: several adoptions (event, override, --remove-node), a delegate cross wire, class defaults; one changed unit applies only itself and its delegate owner; a stub lock change re-plans all", async () => {
  await withRig({ overrideEvent: true, spareNode: true }, async (r) => {
    writePhase2Project(r.dir);
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    let x = await r.run(["adopt", RELAY_ASSET, "OtherEvent", "--remove-node", SPARE_NODE, "--yes"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(x.out.includes(`(--remove-node): ${SPARE_NODE}`), x.out);
    x = await r.run(["adopt", RELAY_ASSET, "override:ReceiveTick", "--yes"]);
    assert.equal(x.code, 0, x.out);
    const adopted = readManifest(r.dir, RELAY_ASSET)!;
    assert.deepEqual(adopted.units.map((u) => u.id).sort(), ["event:OtherEvent", "event:UpdateTarget", "override:ReceiveTick"]);
    assert.ok(adopted.units.find((u) => u.id === "event:OtherEvent")!.adopt!.nodes.includes(SPARE_NODE), "the spare node is part of the adoption");
    assert.equal(r.backend.applyLabels().length, 0, "adopting never applies");

    // one build: the three adopted units are replaced, the two new ones are added
    const first = r.backend.calls.length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const names = r.backend.nodeNames(RELAY_ASSET);
    for (const gone of ["K2Node_CustomEvent_0", "K2Node_CustomEvent_1", "K2Node_Event_5", SPARE_NODE]) {
      assert.ok(!names.includes(gone), `${gone} is removed with its unit`);
    }
    const all = appliedUnits(r.backend, first);
    assert.deepEqual(all.events, ["OtherEvent", "Scan", "Start", "UpdateTarget"]);
    assert.equal(all.overrides, 1);
    const scanId = all.ids.Scan!;
    assert.ok(
      all.wires.some(([from, to]) => from === `${scanId}.OutputDelegate` && !to!.endsWith(".execute")),
      "the delegate of Scan is wired to the timer call of Start",
    );

    // class defaults: one python entry with the fixed template and the values of the @blueprint options
    assert.equal(r.backend.pythonCode.length, 1);
    const code = r.backend.pythonCode[0]!.code;
    assert.match(code, /unreal\.get_default_object\(unreal\.load_class\(None, "\/TestMod\/Relay\/BP_Relay\.BP_Relay_C"\)\)/);
    assert.match(code, /cdo\.set_editor_property\("replicates", True\)/);
    assert.match(code, /cdo\.set_editor_property\("net_update_frequency", 2\.0+\)/);
    assert.match(code, /cdo\.set_actor_tick_interval\(0\.1/);
    assert.equal(r.backend.applyLabels().filter((l) => l === "defaults").length, 1);

    // an unchanged build does nothing
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);

    // change one unit: only that unit and the unit that takes its delegate are applied; the defaults pass does not repeat
    writeFileSync(join(r.dir, "src", "Relay.ts"), PHASE2_RELAY.replace("    this.Visible = false;\n  }\n}\n", "    this.Visible = true;\n  }\n}\n"), "utf8");
    const second = r.backend.calls.length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const part = appliedUnits(r.backend, second);
    assert.deepEqual(part.events, ["Scan", "Start"]);
    assert.equal(part.overrides, 0);
    assert.equal(r.backend.pythonCode.length, 1, "unchanged class defaults are not applied again");

    // a changed stub lock: every unit is planned again although no IR hash changed
    const cacheFile = join(r.dir, ".abfc", "cache", "units.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Record<string, Record<string, Record<string, string>>>;
    for (const u of Object.values(cache[RELAY_ASSET]!)) u.stubLockHash = "other";
    writeFileSync(cacheFile, JSON.stringify(cache), "utf8");
    const third = r.backend.calls.length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const full = appliedUnits(r.backend, third);
    assert.deepEqual(full.events, ["OtherEvent", "Scan", "Start", "UpdateTarget"]);
    assert.equal(full.overrides, 1);
  });
});

// ---- Renaming an owned event and calling it from another event in the same build ----

const KICK = ["", "  @event", "  Kick(): void {", "    this.UpdateTargetNew();", "  }"];

/** Renames the owned event `UpdateTarget` and adds an event that calls it; returns the 1-based line of the call. */
function renameEvent(dir: string): number {
  const src = join(dir, "src", "Relay.ts");
  const text = readFileSync(src, "utf8").replace("UpdateTarget(): void {", "UpdateTargetNew(): void {");
  const spec = join(dir, "src", "Relay.test.ts");
  writeFileSync(spec, readFileSync(spec, "utf8").replace('"UpdateTarget"', '"UpdateTargetNew"'), "utf8");
  const lines = text.replace(/\s+$/, "").split("\n");
  assert.equal(lines[lines.length - 1], "}");
  lines.splice(lines.length - 1, 0, ...KICK);
  writeFileSync(src, lines.join("\n") + "\n", "utf8");
  return lines.indexOf(KICK[3]!) + 1;
}

test("(r1) renaming an owned event and calling it from a new event: the old unit is removed from the stage and the manifest", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const old = readManifest(r.dir, RELAY_ASSET)!.units.find((u) => u.id === "event:UpdateTarget")!;
    assert.ok(old.nodes.length > 0 && old.tag !== null);
    const gone = [...old.nodes, old.tag!];
    for (const n of gone) assert.ok(r.backend.nodeNames(RELAY_ASSET).includes(n), `${n} is on the stage`);

    renameEvent(r.dir);
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /applied .*UpdateTargetNew/);
    assert.match(x.out, /removed .*UpdateTarget\b/);
    assert.deepEqual(readManifest(r.dir, RELAY_ASSET)!.units.map((u) => u.id).sort(), ["event:Kick", "event:UpdateTargetNew"]);
    const names = r.backend.nodeNames(RELAY_ASSET);
    for (const n of gone) assert.ok(!names.includes(n), `${n} is gone from the stage`);
    assert.equal(names.filter((n) => n.startsWith("EdGraphNode_Comment")).length, 2, "one tag per remaining unit");

    // the same state again is up to date
    const before = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, before);
  });
});

test("(r2) without the self_event_calls feature the call to the new event is ABFC4013 at the call; nothing is applied", async () => {
  await withRig({ handMadeEvent: false, selfEventCalls: false }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const before = r.backend.applyLabels().length;
    const line = renameEvent(r.dir);
    const x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, new RegExp(String.raw`Relay\.ts:${line}:\d+: error ABFC4013: calling UpdateTargetNew needs`));
    assert.equal(r.backend.applyLabels().length, before, "nothing is applied");
    assert.deepEqual(readManifest(r.dir, RELAY_ASSET)!.units.map((u) => u.id), ["event:UpdateTarget"], "the manifest is untouched");
  });
});

test("(r3) an apply that fails on the call is reported once, at the call's TS line", async () => {
  await withRig({ handMadeEvent: false, selfEventCalls: false, advertiseSelfEventCalls: true }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const line = renameEvent(r.dir);
    const x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    const errors = x.out.split("\n").filter((l) => /error ABFC\d+/.test(l));
    assert.equal(errors.length, 1, x.out);
    assert.match(errors[0]!, new RegExp(String.raw`Relay\.ts:${line}:\d+: error ABFC6001: \[Unreal\] no pin 'execute'`));
    assert.doesNotMatch(x.out, /\[spec:/);
    assert.deepEqual(readManifest(r.dir, RELAY_ASSET)!.units.map((u) => u.id), ["event:UpdateTarget"], "the manifest is untouched");
  });
});

/** Replaces the relay class by one event that owns no variable (so nothing but the event is left to retire). */
function useMinimalRelay(dir: string): void {
  rmSync(join(dir, "src", "Relay.test.ts"));
  writeFileSync(
    join(dir, "src", "Relay.ts"),
    [
      'import { blueprint, event } from "@abfc/runtime";',
      'import { Actor } from "/Script/FakeEngine";',
      'import type { BP_Relay_Manual } from "/TestMod/Relay/BP_Relay";',
      "",
      "export interface BP_Relay extends BP_Relay_Manual {}",
      "",
      '@blueprint({ path: "/TestMod/Relay/BP_Relay" })',
      "export class BP_Relay extends Actor {",
      "  @event",
      "  UpdateTarget(): void {",
      "    this.HideAll();",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Deletes the relay class from the rig; an empty module keeps the project valid (TypeScript refuses a project without input files). */
function deleteRelaySources(dir: string): void {
  rmSync(join(dir, "src", "Relay.ts"));
  writeFileSync(join(dir, "src", "Other.ts"), "export {};\n", "utf8");
}

test("(r5) deleting a class's TypeScript retires its units on build, publish publishes the asset, then forgets it", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    useMinimalRelay(r.dir);
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const old = readManifest(r.dir, RELAY_ASSET)!.units.find((u) => u.id === "event:UpdateTarget")!;
    const gone = [...old.nodes, old.tag!];
    for (const n of gone) assert.ok(r.backend.nodeNames(RELAY_ASSET).includes(n), `${n} is on the stage`);
    // a first publish of the built class empties the list of changed files
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.publishCalls.length, 1);

    deleteRelaySources(r.dir);
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /removed .*UpdateTarget/);
    const names = r.backend.nodeNames(RELAY_ASSET);
    for (const n of gone) assert.ok(!names.includes(n), `${n} is gone from the stage`);
    const m = readManifest(r.dir, RELAY_ASSET)!;
    assert.deepEqual(m.units, []);
    assert.deepEqual(m.retiredUnpublished, ["event:UpdateTarget"]);

    // a second build changes nothing
    const before = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.applyLabels().length, before);
    assert.deepEqual(readManifest(r.dir, RELAY_ASSET)!.retiredUnpublished, ["event:UpdateTarget"]);

    x = await r.run(["publish", "--dry-run"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /changed Content\/Relay\/BP_Relay\.uasset/);

    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.publishCalls.length, 2);
    assert.deepEqual(r.backend.publishCalls[1]!.assets, [RELAY_ASSET]);
    assert.match(x.out, /no longer owned by abfc: \/TestMod\/Relay\/BP_Relay/);
    assert.equal(readManifest(r.dir, RELAY_ASSET), null, "the manifest is deleted");
    assert.equal(readSourceMap(r.dir, RELAY_ASSET), null, "the source map is deleted");
    const cache = JSON.parse(readFileSync(join(r.dir, ".abfc", "cache", "units.json"), "utf8")) as Record<string, unknown>;
    assert.ok(!(RELAY_ASSET in cache), "the unit cache forgot the asset");

    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /nothing to publish\./);
    assert.equal(r.backend.publishCalls.length, 2);
  });
});

test("(r6) a deleted class whose class defaults abfc set: ABFC5010 warning, units removed, exit 0", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    useMinimalRelay(r.dir);
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const manifestFile = join(r.dir, ".abfc", "manifest", "TestMod__Relay__BP_Relay.json");
    const m = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    m.classDefaultsHash = "sha256:test";
    writeFileSync(manifestFile, JSON.stringify(m), "utf8");

    deleteRelaySources(r.dir);
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC5010: \/TestMod\/Relay\/BP_Relay is no longer declared in TypeScript/);
    assert.deepEqual(readManifest(r.dir, RELAY_ASSET)!.units, []);

    // the class defaults hash keeps the manifest after the publish (the defaults stay on the stage)
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.ok(readManifest(r.dir, RELAY_ASSET) !== null);
    assert.equal(readManifest(r.dir, RELAY_ASSET)!.retiredUnpublished, undefined);
  });
});

test("(r4) a compile error 'Could not find a function' for a call in TS is reported at the call", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const line = renameEvent(r.dir);
    r.backend.reportMessages = [{ severity: "error", asset: RELAY_ASSET, message: `Could not find a function named "UpdateTargetNew" in 'BP_Relay_C'.` }];
    const x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, new RegExp(String.raw`Relay\.ts:${line}:\d+: error ABFC6001: \[Unreal\] Could not find a function named "UpdateTargetNew"`));
  });
});

// ---- One ownership tag comment per unit: re-planning replaces the tag, orphans of older builds are cleaned ----

const isTag = (r: Rig, n: string): boolean => /^NodeComment="abfc:owned unit=/.test(r.backend.nodeHead(RELAY_ASSET, n).find((h) => h.startsWith("NodeComment=")) ?? "");
const tagNames = (r: Rig): string[] => r.backend.nodeNames(RELAY_ASSET).filter((n) => isTag(r, n));

function setVisible(dir: string, value: boolean): void {
  const src = join(dir, "src", "Relay.ts");
  const text = readFileSync(src, "utf8");
  const next = text.replace(/this.Visible = (true|false);/, `this.Visible = ${value};`);
  assert.notEqual(next, text);
  writeFileSync(src, next, "utf8");
}

test("(t1) re-planning a unit replaces its tag comment: exactly one tag per unit after every build", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const units = readManifest(r.dir, RELAY_ASSET)!.units;
    assert.equal(tagNames(r).length, units.length);
    const first = readManifest(r.dir, RELAY_ASSET)!.units.find((u) => u.id === "event:UpdateTarget")!.tag!;

    for (const visible of [false, true]) {
      setVisible(r.dir, visible);
      const x = await r.run(["build"]);
      assert.equal(x.code, 0, x.out);
      assert.match(x.out, /applied UpdateTarget/);
      const m = readManifest(r.dir, RELAY_ASSET)!;
      assert.equal(m.units.length, units.length);
      const tags = tagNames(r);
      assert.equal(tags.length, m.units.length, `one tag per unit: ${tags.join(", ")}`);
      assert.deepEqual([...tags].sort(), m.units.map((u) => u.tag!).sort(), "the manifest records the tag that is on the stage");
    }
    assert.ok(!r.backend.nodeNames(RELAY_ASSET).includes(first), "the first tag comment is gone");
  });
});

test("(t2) orphan tag comments of an unchanged unit are removed once its asset is read (build --resync, publish); a plain build leaves them", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const m = readManifest(r.dir, RELAY_ASSET)!;
    const unit = m.units.find((u) => u.id === "event:UpdateTarget")!;
    const orphans = [r.backend.addOrphanTag(RELAY_ASSET, unit.tag!, "92f777f3"), r.backend.addOrphanTag(RELAY_ASSET, unit.tag!, "de5b7500")];
    assert.equal(tagNames(r).length, m.units.length + 2);

    // nothing changed: a plain build does not read the asset and does not touch the stage
    const before = r.backend.applyLabels().length;
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.equal(r.backend.applyLabels().length, before);

    // build --resync reads every owned asset (the stage is copied from the published mod again): the orphans go
    r.backend.keepAssetsOnSync = true;
    x = await r.run(["build", "--resync"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /orphan tag comment/);
    assert.equal(readManifest(r.dir, RELAY_ASSET)!.units.length, m.units.length);
    assert.deepEqual(tagNames(r).sort(), m.units.map((u) => u.tag!).sort(), "only the recorded tags remain");
    for (const o of orphans) assert.ok(!r.backend.nodeNames(RELAY_ASSET).includes(o));
  });
});

test("(r5) a stale stub that still lists an owned event as hand-made is not a way to call it: the removed event is a TS error at the call, before any backend work", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    // the stubs were written before abfc owned UpdateTarget, so they still list it as a hand-made member
    const stub = join(r.dir, ".abfc", "stubs", "test", "Mod", "TestMod", "Relay", "BP_Relay.d.ts");
    const stale = readFileSync(stub, "utf8").replace(
      "  HideAll(): void;\n",
      "  HideAll(): void;\n  /**\n   * @bpPath /TestMod/Relay/BP_Relay.BP_Relay_C:UpdateTarget\n   * @bpHandMade\n   */\n  UpdateTarget(): void;\n",
    );
    assert.notEqual(stale, readFileSync(stub, "utf8"));
    writeFileSync(stub, stale, "utf8");

    const line = renameEvent(r.dir);
    const src = join(r.dir, "src", "Relay.ts");
    writeFileSync(src, readFileSync(src, "utf8").replace("this.UpdateTargetNew();", "this.UpdateTarget();"), "utf8");
    const before = r.backend.applyLabels().length;
    const x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, new RegExp(String.raw`Relay\.ts:${line}:\d+: error ABFC2000: \[TS\d+\] Property 'UpdateTarget' does not exist`));
    assert.equal(r.backend.applyLabels().length, before, "nothing is applied");
    assert.deepEqual(readManifest(r.dir, RELAY_ASSET)!.units.map((u) => u.id), ["event:UpdateTarget"], "the manifest is untouched");

    // members abfc does not own stay reachable
    writeFileSync(src, readFileSync(src, "utf8").replace("this.UpdateTarget();", "this.HideAll();"), "utf8");
    const ok = await r.run(["check"]);
    assert.equal(ok.code, 0, ok.out);
  });
});

test("(r6) an event the build removed stays hidden in the stale stub: calling it afterwards is a TS error", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const stub = join(r.dir, ".abfc", "stubs", "test", "Mod", "TestMod", "Relay", "BP_Relay.d.ts");
    const text = readFileSync(stub, "utf8");
    writeFileSync(
      stub,
      text.replace("  HideAll(): void;\n", "  HideAll(): void;\n  /**\n   * @bpPath /TestMod/Relay/BP_Relay.BP_Relay_C:UpdateTarget\n   * @bpHandMade\n   */\n  UpdateTarget(): void;\n"),
      "utf8",
    );
    renameEvent(r.dir);
    const x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /removed .*UpdateTarget\b/);
    assert.deepEqual(readRetired(r.dir), { [RELAY_ASSET]: ["event:UpdateTarget"] });

    const src = join(r.dir, "src", "Relay.ts");
    writeFileSync(src, readFileSync(src, "utf8").replace("this.UpdateTargetNew();", "this.UpdateTarget();"), "utf8");
    const bad = await r.run(["check"]);
    assert.notEqual(bad.code, 0, bad.out);
    assert.match(bad.out, /error ABFC2000: \[TS\d+\] Property 'UpdateTarget' does not exist/);
  });
});

test("(r7) forgetting a never-synced adoption does not retire the unit: the hand-made member stays visible", async () => {
  await withRig({ handMadeEvent: true }, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    renameEvent(r.dir);
    const x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(readRetired(r.dir), {}, "nothing of the forgotten unit was deleted from the stage");
  });
});

test("(h) test.liveHud: skipped hidden with ABFC6105, listed in manual-checks.md and output.json, the game test is not called for it", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    writeFileSync(
      join(r.dir, "src", "Hud.test.ts"),
      [
        'import { test } from "@abfc/testkit";',
        'import { BP_Relay } from "./Relay.js";',
        "",
        'test.liveHud("HUD shows the relay", ["Start Play In Editor", "Look at the pot"], (t) => {',
        "  const relay = t.spawn(BP_Relay);",
        "  relay.call(\"UpdateTarget\");",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    r.backend.gameTestCalls = 0;
    let x = await r.run(["test", "--no-build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(x.out.split("\n").filter((l) => /warning ABFC6105: HUD shows the relay needs the live HUD; skipped hidden \(manual check\)/.test(l)).length, 1, x.out);
    assert.match(x.out, /2 of 2 test\(s\) passed/);
    assert.equal(r.backend.gameTestCalls, 2, "only the two hidden tests reach bp_game_test");
    const report = readFileSync(join(r.dir, ".abfc", "reports", "manual-checks.md"), "utf8");
    assert.match(report, /## HUD shows the relay/);
    assert.match(report, /src\/Hud\.test\.ts:4/);
    assert.match(report, /1\. \[ \] Start Play In Editor\r?\n2\. \[ \] Look at the pot/);
    assert.match(report, /Run in Play In Editor with the mod enabled; tick each item\./);

    x = await r.run(["test", "--no-build", "--json"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /"manualChecks":\s*\[/);
    assert.match(x.out, /"Look at the pot"/);

    // nothing but liveHud tests: no backend is started
    rmSync(join(r.dir, "src", "Relay.test.ts"));
    const before = r.started.count;
    r.backend.gameTestCalls = 0;
    x = await r.run(["test", "--no-build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC6105/);
    assert.equal(r.started.count, before, "the backend is not started");
    assert.equal(r.backend.gameTestCalls, 0);
  });
});

test("(p3) a class file whose derived path changed: ABFC5012 stops the build before the backend starts, and path: keeps the asset", async () => {
  await withRig({}, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    assert.equal((await r.run(["build"])).code, 0);
    const src = join(r.dir, "src", "Relay.ts");
    const text = readFileSync(src, "utf8");
    writeFileSync(src, text.replace('@blueprint({ path: "/TestMod/Relay/BP_Relay" })', "@blueprint()"), "utf8");
    const starts = r.started.count;
    const applies = r.backend.applyLabels().length;
    let x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /error ABFC5012: BP_Relay was built as \/TestMod\/Relay\/BP_Relay \(from src\/Relay\.ts\) but its file now gives \/TestMod\/BP_Relay/);
    assert.match(x.out, /path: "Relay\/BP_Relay"/);
    assert.equal(r.started.count, starts, "the backend is not started");
    assert.equal(r.backend.applyLabels().length, applies);
    x = await r.run(["check"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC5012/);
    writeFileSync(src, text.replace('{ path: "/TestMod/Relay/BP_Relay" }', '{ path: "Relay/BP_Relay" }'), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(readManifest(r.dir, RELAY_ASSET)!.source?.derived, false);
  });
});

test("(p4) a class with an own field: the apply spec declares the variable, it enters the manifest, and a rebuild is up to date", async () => {
  await withRig({}, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    assert.equal((await r.run(["build"])).code, 0);
    const src = join(r.dir, "src", "Relay.ts");
    const text = readFileSync(src, "utf8");
    writeFileSync(
      src,
      'import type { int } from "@abfc/runtime";\n' + text.replace("export class BP_Relay extends Actor {\n", "export class BP_Relay extends Actor {\n  Score!: int;\n"),
      "utf8",
    );
    const before = r.backend.calls.filter((c) => c.tool === "bp_apply").length;
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const applies = r.backend.calls.filter((c) => c.tool === "bp_apply").slice(before);
    const declared = applies.flatMap((c) => c.specs!.flatMap((s: any) => (s.variables ?? []).map((v: any) => v.name)));
    assert.equal(declared.filter((n: string) => n === "Score").length, 1, JSON.stringify(declared));
    assert.ok(readManifest(r.dir, RELAY_ASSET)!.variables.some((v) => v.name === "Score" && v.type === "int"));
    const again = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.applyLabels().length, again, "a rebuild does not declare it again");
  });
});

// ---- Creating a missing Blueprint asset ----

const TALLY = `import { blueprint, event } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_Tally" })
export class BP_Tally extends Actor {
  Total!: int;

  @event
  Bump(by: int): void {
    this.Total = by;
  }
}
`;
const TALLY_ASSET = "/TestMod/Relay/BP_Tally";

test("a class whose asset is not in the stage is created once, then built like any other", async () => {
  await withRig({}, async (r) => {
    rmSync(join(r.dir, "src", "Relay.ts"));
    rmSync(join(r.dir, "src", "Relay.test.ts"));
    writeFileSync(join(r.dir, "src", "Tally.ts"), TALLY, "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const specs = r.backend.calls.filter((c) => c.tool === "bp_apply").flatMap((c) => c.specs ?? []);
    const creating = specs.filter((s: any) => s.asset === TALLY_ASSET && s.create !== undefined);
    assert.equal(creating.length, 1, JSON.stringify(specs.map((s: any) => [s.asset, s.create])));
    assert.deepEqual(creating[0]!.create, { class: "Blueprint", parent: "/Script/FakeEngine.Actor", if_missing: true });
    const m = readManifest(r.dir, TALLY_ASSET);
    assert.ok(m, "manifest written");
    assert.deepEqual(m!.units.map((u) => u.id), ["event:Bump"]);
    assert.ok(m!.variables.some((v) => v.name === "Total" && v.type === "int"));

    const again = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.applyLabels().length, again, "a second build is up to date");
  });
});

// ---- Feature gate: Map/Set need a backend that reports them ----

const MAPPED = `import { blueprint, event } from "@abfc/runtime";
import type { int, name } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_Mapped" })
export class BP_Mapped extends Actor {
  Counts!: Map<name, int>;

  @event
  Bump(key: name, by: int): void {
    this.Counts.set(key, by);
  }
}
`;

test("a Map field with a backend that does not report map support is ABFC2044 before the stage is touched; no bp_apply is sent", async () => {
  await withRig({}, async (r) => {
    rmSync(join(r.dir, "src", "Relay.ts"));
    rmSync(join(r.dir, "src", "Relay.test.ts"));
    writeFileSync(join(r.dir, "src", "Mapped.ts"), MAPPED, "utf8");
    for (const args of [["build"], ["check"]]) {
      const x = await r.run(args);
      if (args[0] === "check") continue;
      assert.notEqual(x.code, 0, x.out);
      assert.match(x.out, /ABFC2044/);
      assert.match(x.out, /Map</);
    }
    assert.equal(r.backend.calls.filter((c) => c.tool === "bp_apply").length, 0);
    assert.equal(r.backend.calls.filter((c) => c.tool === "staging_sync").length, 0);
    assert.equal(r.backend.calls.filter((c) => c.tool === "bp_read").length, 0);
  });
});

// ---- Mod-defined structs ----

const STRUCT_SRC = (extra: string): string => `import { blueprint, event, struct } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@struct({ path: "/TestMod/Relay/S_Entry" })
export class S_Entry {
  Count!: int;
${extra}}

@blueprint({ path: "/TestMod/Relay/BP_Holder" })
export class BP_Holder extends Actor {
  Entry!: S_Entry;
  Total!: int;

  @event
  Use(): void {
    this.Total = this.Entry.Count + 1;
  }
}
`;
const STRUCT_ASSET = "/TestMod/Relay/S_Entry";
const HOLDER_ASSET = "/TestMod/Relay/BP_Holder";

function appliedSpecs(r: { backend: FakeBackend }): Array<Record<string, any>> {
  return r.backend.calls.filter((c) => c.tool === "bp_apply").flatMap((c) => c.specs ?? []);
}

test("a @struct is created before the Blueprint that uses it; a rebuild plans no struct; changing its fields is ABFC2046", async () => {
  await withRig({ structs: true }, async (r) => {
    rmSync(join(r.dir, "src", "Relay.ts"));
    rmSync(join(r.dir, "src", "Relay.test.ts"));
    writeFileSync(join(r.dir, "src", "Holder.ts"), STRUCT_SRC(""), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const specs = appliedSpecs(r);
    const si = specs.findIndex((s) => s.asset === STRUCT_ASSET);
    const hi = specs.findIndex((s) => s.asset === HOLDER_ASSET);
    assert.ok(si >= 0 && hi > si, JSON.stringify(specs.map((s) => s.asset)));
    assert.equal(specs[si]!.create.class, "UserDefinedStruct");
    assert.equal(specs[si]!.struct_fields.length, 1);
    assert.equal(specs[si]!.struct_fields[0].friendly, "Count");
    const entry = (specs[hi]!.variables as Array<{ name: string; type: string }>).find((v) => v.name === "Entry");
    assert.equal(entry?.type, `struct:${STRUCT_ASSET}.S_Entry`);
    assert.ok(readManifest(r.dir, STRUCT_ASSET)?.structFieldsHash);

    const before = appliedSpecs(r).length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(appliedSpecs(r).length, before, "a rebuild applies nothing");

    writeFileSync(join(r.dir, "src", "Holder.ts"), STRUCT_SRC("  Extra!: int;\n"), "utf8");
    x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC2046/);
    assert.equal(appliedSpecs(r).length, before, "nothing is applied after the error");
  });
});

test("a @struct with a backend that cannot create a UserDefinedStruct is ABFC2044 before any apply", async () => {
  await withRig({}, async (r) => {
    rmSync(join(r.dir, "src", "Relay.ts"));
    rmSync(join(r.dir, "src", "Relay.test.ts"));
    writeFileSync(join(r.dir, "src", "Holder.ts"), STRUCT_SRC(""), "utf8");
    const x = await r.run(["build"]);
    assert.notEqual(x.code, 0, x.out);
    assert.match(x.out, /ABFC2044/);
    assert.equal(r.backend.calls.filter((c) => c.tool === "bp_apply").length, 0);
  });
});

const DIRECTOR_ROW = "/TestMod/DataTables/DT_ClassManager/EntityDirector_Test";

function addDirector(dir: string, row = "EntityDirector_Test"): void {
  const file = join(dir, "src", "Relay.ts");
  const text = readFileSync(file, "utf8").replace(/@director\("[^"]*"\)\n/, "");
  const withImport = text.includes("director") ? text : `import { director } from "@abfc/runtime";\n${text}`;
  writeFileSync(file, withImport.replace("@blueprint(", `@director("${row}")\n@blueprint(`), "utf8");
}

test("(row1) @director with the classManagerRows capability: the spec carries class_manager_row, the manifest records directorRow, publish lists the row; a new row name warns ABFC5013", async () => {
  await withRig({ handMadeEvent: false, classManagerRows: true }, async (r) => {
    addDirector(r.dir);
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const defaults = r.backend.calls.filter((c) => c.tool === "bp_apply" && c.label === "defaults");
    assert.equal(defaults.length, 1);
    assert.deepEqual(defaults[0]!.specs![0]!.class_manager_row, { asset_path: DIRECTOR_ROW, class_path: "/TestMod/Relay/BP_Relay.BP_Relay_C" });
    assert.doesNotMatch(r.backend.pythonCode[0]!.code, /row_asset/);
    assert.match(x.out, /class-manager row \/TestMod\/DataTables\/DT_ClassManager\/EntityDirector_Test: created/);
    assert.equal(readManifest(r.dir, RELAY_ASSET)?.directorRow, DIRECTOR_ROW);
    assert.doesNotMatch(x.out, /ABFC2077|ABFC5013/);

    const p = await r.run(["publish", "--dry-run"]);
    assert.match(p.out, /DataTables\/DT_ClassManager\/EntityDirector_Test\.uasset/);

    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    addDirector(r.dir, "EntityDirector_Other");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC5013: the previous class-manager row \/TestMod\/DataTables\/DT_ClassManager\/EntityDirector_Test stays in the mod; delete it in the Mod Editor/);
    assert.equal(readManifest(r.dir, RELAY_ASSET)?.directorRow, "/TestMod/DataTables/DT_ClassManager/EntityDirector_Other");
  });
});

test("(row2) @director without the capability keeps the verify route and warns ABFC2077; no directorRow is recorded", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    addDirector(r.dir);
    const x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC2077: the backend cannot write class-manager rows; update abf-mod-editor-mcp to 2\.5\.0 or newer/);
    assert.equal(r.backend.calls.find((c) => c.label === "defaults")!.specs![0]!.class_manager_row, undefined);
    assert.match(r.backend.pythonCode[0]!.code, /row_asset = unreal\.load_asset\("\/TestMod\/DataTables\/DT_ClassManager\/EntityDirector_Test"\)/);
    assert.equal(readManifest(r.dir, RELAY_ASSET)?.directorRow, undefined);
  });
});
