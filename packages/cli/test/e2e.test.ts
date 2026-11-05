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
import { FakeBackend, RELAY_ASSET } from "./fake-backend.js";
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
  started: { count: number };
  run(argv: string[]): Promise<Run>;
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
    const started = { count: 0 };
    const run = async (argv: string[]): Promise<Run> => {
      const lines: string[] = [];
      const deps: CliDeps = {
        host,
        startBackend: async () => {
          started.count++;
          return backend;
        },
        now: () => new Date(2026, 0, 2, 3, 4, 5),
        cwd: dir,
        stdout: (l) => lines.push(l),
        stderr: (l) => lines.push(l),
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

    const before = r.backend.applyLabels().length;
    let x = await r.run(["build"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC5001/);
    assert.equal(r.backend.applyLabels().length, before, "no bp_apply after the drift");

    x = await r.run(["status"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /event:UpdateTarget edited/);
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
