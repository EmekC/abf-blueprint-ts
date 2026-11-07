// `abfc check --watch` on the fixture project (a synthetic mod, TestMod) with a fake file watcher.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfile, realHost, resolveEnvironment } from "@abfc/env";
import type { Host } from "@abfc/env";
import { newLock, writeLock } from "@abfc/stubgen";
import { main } from "../src/index.js";
import type { CliDeps } from "../src/index.js";
import { fakeEnvironmentFiles } from "./helpers.js";

const profile = loadProfile();
const here = fileURLToPath(new URL("./", import.meta.url));
const fixtureProject = fileURLToPath(new URL("../../../compiler/test/fixtures/project", import.meta.url));

const key = (p: string): string => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

/** The fake machine for everything outside `roots`; the real file system below them. */
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

interface Rig {
  dir: string;
  lines: string[];
  deps: CliDeps;
  ac: AbortController;
  /** Calls the registered `onChange` with a project-relative path. */
  touch(rel: string): void;
  closed(): boolean;
}

async function withRig(fn: (r: Rig) => Promise<void>): Promise<void> {
  // inside the package tree so that `@abfc/runtime` still resolves through the workspace node_modules
  const dir = mkdtempSync(join(here, "watch-"));
  try {
    cpSync(fixtureProject, dir, { recursive: true });
    rmSync(join(dir, "src", "Bad.ts"));
    writeFileSync(join(dir, "abf.config.json"), JSON.stringify({ mod: { name: "TestMod" }, backend: { kind: "bp_apply", minProtocol: 1 } }), "utf8");
    const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
    const host = hybridHost(fake.host(), [dir]);
    const env = resolveEnvironment(host, { projectDir: dir, flags: {} });
    writeLock(
      join(dir, ".abfc", "stubs", profile.id),
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
    const lines: string[] = [];
    const ac = new AbortController();
    let onChange: ((file: string) => void) | null = null;
    let closed = false;
    const deps: CliDeps = {
      host,
      startBackend: async () => {
        throw new Error("check --watch never starts the backend");
      },
      now: () => new Date(2026, 0, 2, 3, 4, 5),
      cwd: dir,
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
      watch: (_dir, cb) => {
        onChange = cb;
        return { close: () => void (closed = true) };
      },
      stopSignal: ac.signal,
    };
    await fn({
      dir,
      lines,
      deps,
      ac,
      touch: (rel) => {
        assert.ok(onChange, "the watcher is registered");
        onChange(join(dir, rel));
      },
      closed: () => closed,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (lines: string[], needle: RegExp): number => lines.filter((l) => needle.test(l)).length;
const FINISHED = /^\[abfc\] check finished: \d+ error\(s\), \d+ warning\(s\) in \d+\.\d\d s$/;

async function waitFor(what: string, ok: () => boolean): Promise<void> {
  const until = Date.now() + 20000;
  while (!ok()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("check --watch: runs once, reruns on a source change, ignores cache files, ends with the signal", async () => {
  await withRig(async (r) => {
    const done = main(["check", "--watch"], r.deps);
    await waitFor("the first run", () => count(r.lines, FINISHED) === 1);
    assert.equal(count(r.lines, /^\[abfc\] check started$/), 1);
    assert.ok(r.lines.some((l) => /^checked 1 unit\(s\) in 1 asset\(s\), 2 test\(s\): no errors$/.test(l)), r.lines.join("\n"));
    assert.ok(r.lines.some((l) => FINISHED.test(l) && l.includes(" 0 error(s), 0 warning(s) ")), "the fixture is clean");

    r.touch("src/Relay.ts");
    await waitFor("the second run", () => count(r.lines, FINISHED) === 2);
    assert.equal(count(r.lines, /^\[abfc\] check started$/), 2);

    r.touch(".abfc/cache/x.json");
    r.touch(".abfc/runs.jsonl");
    r.touch("node_modules/x/index.ts");
    r.touch("README.md");
    await sleep(500);
    assert.equal(count(r.lines, FINISHED), 2, "irrelevant files do not trigger a run");

    // two quick saves are one run
    r.touch("src/Relay.ts");
    r.touch("src/Relay.test.ts");
    await waitFor("the third run", () => count(r.lines, FINISHED) === 3);
    await sleep(500);
    assert.equal(count(r.lines, FINISHED), 3, "the debounce merges quick saves");

    // a stub file, a manifest and the config are relevant
    for (const rel of [".abfc/stubs/test/Script/Foo.d.ts", ".abfc/manifest/x.json", "abf.config.json", "tsconfig.json"]) {
      const before = count(r.lines, FINISHED);
      r.touch(rel);
      await waitFor(`a run after ${rel}`, () => count(r.lines, FINISHED) === before + 1);
    }

    r.ac.abort();
    assert.equal(await done, 0);
    assert.ok(r.closed(), "the watcher is closed");
  });
});

test("check --watch: reports errors in the finished line and recovers when the file is fixed", async () => {
  await withRig(async (r) => {
    const done = main(["check", "--watch"], r.deps);
    await waitFor("the first run", () => count(r.lines, FINISHED) === 1);
    const file = join(r.dir, "src", "Broken.ts");
    writeFileSync(file, "export const x: number = 'a';\n", "utf8");
    r.touch("src/Broken.ts");
    await waitFor("the second run", () => count(r.lines, FINISHED) === 2);
    const second = r.lines.filter((l) => FINISHED.test(l))[1]!;
    assert.match(second, /: [1-9]\d* error\(s\)/);
    assert.ok(r.lines.some((l) => /Broken\.ts:\d+:\d+: error ABFC2000: \[TS2322\]/.test(l)), r.lines.join("\n"));
    rmSync(file);
    r.touch("src/Broken.ts");
    await waitFor("the third run", () => count(r.lines, FINISHED) === 3);
    assert.match(r.lines.filter((l) => FINISHED.test(l))[2]!, /: 0 error\(s\)/);
    r.ac.abort();
    assert.equal(await done, 0);
  });
});

test("check --watch: a change right after a run starts triggers exactly one more run", async () => {
  await withRig(async (r) => {
    const done = main(["check", "--watch"], r.deps);
    // the first run is synchronous work after the first await; touch right away so the change lands while it runs or just after
    await waitFor("the first start", () => count(r.lines, /^\[abfc\] check started$/) === 1);
    r.touch("src/Relay.ts");
    await waitFor("the second run", () => count(r.lines, FINISHED) === 2);
    await sleep(400);
    assert.equal(count(r.lines, FINISHED), 2);
    r.ac.abort();
    assert.equal(await done, 0);
  });
});

test("check --watch together with --json is a usage error (exit 2)", async () => {
  await withRig(async (r) => {
    const code = await main(["check", "--watch", "--json"], r.deps);
    assert.equal(code, 2);
    assert.ok(r.lines.some((l) => l === "abfc: error: --watch cannot be combined with --json"), r.lines.join("\n"));
    assert.equal(count(r.lines, /check started/), 0);
  });
});
