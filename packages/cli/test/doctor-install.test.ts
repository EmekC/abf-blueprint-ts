import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/index.js";
import { ALL_TOOLS, captureDeps, fakeEnvironmentFiles, fixInfo, scriptedBackend } from "./helpers.js";

// The install block of `abfc doctor`, `--deep` and `--clean-runtimes`. Every test supplies a fake `deps.install`,
// so nothing touches a real runtime folder.

const EXT = { extProtocol: 1, serverVersion: "fake-1", python: "3.11.9", features: ["reflect", "compile_node_refs", "bp_read_seconds"] };
const RT = "C:\\rt";
const CUR = "C:\\rt\\1.0.0-abcdef12";
const OLD = "C:\\rt\\0.9.0-deadbeef";
const TMP = "C:\\rt\\.tmp-x";
const BUSY = "C:\\rt\\0.8.0-cafebabe";

function fakeInstall(kind: "exe" | "source") {
  const calls: string[] = [];
  const install = {
    info: () =>
      kind === "exe"
        ? { kind: "exe" as const, abfcVersion: "1.0.0", runtimeDir: CUR, runtimeRoot: RT }
        : { kind: "source" as const, abfcVersion: null, runtimeDir: null, runtimeRoot: RT },
    verify: (deep: boolean) => {
      calls.push(`verify ${deep}`);
      return kind === "exe" ? { dir: CUR, extracted: false, repaired: true, files: 42 } : null;
    },
    clean: () => {
      calls.push("clean");
      return kind === "exe" ? { removed: [OLD, TMP], failed: [BUSY], kept: CUR } : { removed: [], failed: [], kept: null };
    },
  };
  return { install, calls };
}

function doctorDeps() {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  return captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo(), abfc_extensions: EXT }));
}

test("doctor prints 'source install' by default and no runtime check line without --deep", async () => {
  const cap = doctorDeps();
  const code = await main(["doctor"], cap.deps);
  assert.equal(code, 0, cap.text());
  assert.match(cap.text(), /^ {2}abfc {13}source install$/m);
  assert.doesNotMatch(cap.text(), /runtime check/);
});

test("doctor shows the exe line; --deep adds the runtime check; --json carries install and runtimeCheck", async () => {
  const cap = doctorDeps();
  const fi = fakeInstall("exe");
  cap.deps.install = fi.install;
  assert.equal(await main(["doctor", "--deep"], cap.deps), 0, cap.text());
  assert.ok(cap.text().includes(`abfc             exe 1.0.0, runtime ${CUR}`), cap.text());
  assert.ok(cap.text().includes("runtime check    42 files verified by sha256 (repaired)"), cap.text());
  assert.deepEqual(fi.calls, ["verify true"]);

  const cap2 = doctorDeps();
  cap2.deps.install = fakeInstall("exe").install;
  assert.equal(await main(["doctor", "--deep", "--json"], cap2.deps), 0, cap2.text());
  const doc = JSON.parse(cap2.text()) as { result: { install: unknown; runtimeCheck: unknown } };
  assert.deepEqual(doc.result.install, { kind: "exe", abfcVersion: "1.0.0", runtimeDir: CUR });
  assert.deepEqual(doc.result.runtimeCheck, { files: 42, repaired: true });
});

test("doctor without --deep does not verify the runtime; a source install says there is nothing to check", async () => {
  const cap = doctorDeps();
  const fi = fakeInstall("exe");
  cap.deps.install = fi.install;
  assert.equal(await main(["doctor"], cap.deps), 0, cap.text());
  assert.deepEqual(fi.calls, []);

  const cap2 = doctorDeps();
  cap2.deps.install = fakeInstall("source").install;
  assert.equal(await main(["doctor", "--deep"], cap2.deps), 0, cap2.text());
  assert.ok(cap2.text().includes("runtime check    none (source install)"), cap2.text());
});

test("doctor --clean-runtimes needs no project: removes, warns about folders in use, keeps the current one", async () => {
  const fake = fakeEnvironmentFiles({});
  for (const k of Object.keys(fake.files)) if (/abf\.config\.json$/i.test(k)) delete fake.files[k];
  const cap = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, {}));
  const fi = fakeInstall("exe");
  cap.deps.install = fi.install;
  cap.deps.host = fake.host();
  const code = await main(["doctor", "--clean-runtimes"], cap.deps);
  const out = cap.text();
  assert.equal(code, 0, out);
  assert.deepEqual(fi.calls, ["clean"]);
  assert.equal(cap.started.count, 0);
  assert.ok(out.includes(`removed ${OLD}`), out);
  assert.ok(out.includes(`removed ${TMP}`), out);
  assert.ok(out.includes(`in use, not removed: ${BUSY}`), out);
  assert.ok(out.includes(`kept ${CUR}`), out);
});

test("doctor --clean-runtimes: 'nothing to remove', and --json lists removed, failed and kept", async () => {
  const fake = fakeEnvironmentFiles({});
  const cap = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, {}));
  cap.deps.install = fakeInstall("source").install;
  assert.equal(await main(["doctor", "--clean-runtimes"], cap.deps), 0, cap.text());
  assert.match(cap.text(), /nothing to remove/);

  const cap2 = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, {}));
  cap2.deps.install = fakeInstall("exe").install;
  assert.equal(await main(["doctor", "--clean-runtimes", "--json"], cap2.deps), 0, cap2.text());
  const doc = JSON.parse(cap2.text()) as { result: unknown };
  assert.deepEqual(doc.result, { removed: [OLD, TMP], failed: [BUSY], kept: CUR });
});
