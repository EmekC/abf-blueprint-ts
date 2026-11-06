// CLI end-to-end on the step 23 fixture project (a synthetic mod, TestMod) against the in-memory fake backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHir, compileTests, loadProgram, lower, readManifest, readSourceMap } from "@abfc/compiler";
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

test("(b1) a build that applies but fails Unreal's compile is repeated by the next unchanged build, and publish gate 3 fails on it", async () => {
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
    x = await r.run(["publish", "--dry-run"]);
    assert.notEqual(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /would publish/);
    const gates = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step === "gate.3");
    assert.equal(gates[gates.length - 1]!.ok, false);

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

test("(b3) publish gate 3 reads every owned asset: an editor edit of an unchanged unit fails with ABFC5001 and nothing is applied", async () => {
  await withRig({}, async (r) => {
    assert.equal((await r.run(["adopt", RELAY_ASSET, "UpdateTarget", "--yes"])).code, 0);
    assert.equal((await r.run(["build"])).code, 0);
    const ir = lowerProject(r.dir);
    const real = readManifest(r.dir, RELAY_ASSET)!.units[0]!.nodeIds[irNode(ir, "EqualEqual_DoubleDouble").id];
    assert.ok(real);
    r.backend.setPinDefault(RELAY_ASSET, real, "B", "5.0");

    const before = r.backend.applyLabels().length;
    assert.equal((await r.run(["build"])).code, 0, "an unchanged build does not read the asset");
    const x = await r.run(["publish", "--dry-run"]);
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

test("(f) publish --dry-run lists the staged changes and never publishes; without --dry-run it is ABFC7001", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    let x = await r.run(["publish", "--dry-run"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /would publish:/);
    assert.match(x.out, /changed Content\/Relay\/BP_Relay\.uasset/);
    assert.doesNotMatch(x.out, /_McpTmp/);
    assert.ok(r.backend.tools().includes("mod_audit"));
    assert.ok(!r.backend.tools().includes("bp_publish"));

    x = await r.run(["publish"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC7001/);
    assert.ok(!r.backend.tools().includes("bp_publish"));
  });
});

test("(f2) publish gate: success passes seven gates, lists only owned assets, times each gate, never calls bp_publish", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    r.backend.extraChanged = ["Content/Other/BP_NotMine.uasset", "Binaries/x.dll"];
    const x = await r.run(["publish", "--dry-run"]);
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
    const x = await r.run(["publish", "--dry-run"]);
    assert.equal(x.code, 2, x.out);
    assert.match(x.out, /error ABFC3001/);
    assert.equal(r.started.count, 0);
    const gates = readRuns(join(r.dir, ".abfc", "runs.jsonl")).filter((e) => e.step.startsWith("gate."));
    assert.deepEqual(gates.map((e) => [e.step, e.ok]), [["gate.1", false]]);
  });
});

test("(f4) publish gate 4: a failing test stops before the audit", async () => {
  await withRig({ handMadeEvent: false, stageAudit: true }, async (r) => {
    assert.equal((await r.run(["build"])).code, 0);
    const cases = compileTests(loadProgram(r.dir), profile).cases;
    const at = cases[0]!.steps.findIndex((s) => "equals" in s.step);
    assert.ok(at >= 0);
    r.backend.gameTestFailures = [[at], []];
    const x = await r.run(["publish", "--dry-run"]);
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
    let x = await r.run(["publish", "--dry-run"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC7002: .*the picker lists two mods/);
    assert.doesNotMatch(x.out, /would publish/);

    r.backend.auditOk = true;
    r.backend.auditRaw = { ok: true, audited_copy: "mod" };
    x = await r.run(["publish", "--dry-run"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC7002: .*audited the mod copy/);
  });
  await withRig({ handMadeEvent: false }, async (r) => {
    const x = await r.run(["publish", "--dry-run"]);
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
    const x = await r.run(["publish", "--dry-run"], { listFiles });
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
