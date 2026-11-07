import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ABFC_VERSION, main } from "../src/index.js";
import { captureDeps, fakeEnvironmentFiles } from "./helpers.js";

// `abfc version` and `abfc --version` need no project, no environment and no backend.

function deps() {
  return captureDeps(fakeEnvironmentFiles({}), async () => {
    throw new Error("the backend must not be started");
  });
}

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "packages")) && existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("repository root (a folder with packages/ and package.json) not found above " + process.cwd());
    dir = up;
  }
}

test("abfc --version prints the version, the install kind and the Node version (exit 0)", async () => {
  const cap = deps();
  const code = await main(["--version"], cap.deps);
  assert.equal(code, 0, cap.text());
  assert.equal(cap.lines.length, 1);
  assert.match(cap.text(), /^abfc \d+\.\d+\.\d+\S* \((exe|source install), node /);
  assert.equal(cap.started.count, 0);
});

test("abfc version prints the same line", async () => {
  const cap = deps();
  const code = await main(["version"], cap.deps);
  assert.equal(code, 0, cap.text());
  assert.equal(cap.text(), `abfc ${ABFC_VERSION} (source install, node ${process.versions.node})`);
});

test("abfc version --json prints one plain object (not the output envelope)", async () => {
  const cap = deps();
  const code = await main(["version", "--json"], cap.deps);
  assert.equal(code, 0, cap.text());
  assert.equal(cap.lines.length, 1);
  const o = JSON.parse(cap.lines[0]!) as Record<string, unknown>;
  assert.deepEqual(o, { version: ABFC_VERSION, install: "source", node: process.versions.node });
});

test("the install kind comes from deps.install", async () => {
  const cap = deps();
  cap.deps.install = {
    info: () => ({ kind: "exe", abfcVersion: ABFC_VERSION, runtimeDir: "C:\\rt\\x", runtimeRoot: "C:\\rt" }),
    verify: () => null,
    clean: () => ({ removed: [], failed: [], skipped: [], kept: null }),
  };
  assert.equal(await main(["--version"], cap.deps), 0, cap.text());
  assert.match(cap.text(), /\(exe, node /);
});

test("--version together with another command is a usage error (exit 2)", async () => {
  const cap = deps();
  const code = await main(["build", "--version"], cap.deps);
  assert.equal(code, 2);
  assert.match(cap.text(), /--version is not an option of abfc build/);
  assert.equal(cap.started.count, 0);
});

test("ABFC_VERSION equals the version of packages/cli/package.json", () => {
  const json = JSON.parse(readFileSync(join(repoRoot(), "packages", "cli", "package.json"), "utf8")) as { version: string };
  assert.equal(ABFC_VERSION, json.version);
});
