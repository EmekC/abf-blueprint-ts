import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkVersions, publicDirs, readWorkspace } from "../lib/versions.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rootLicense = readFileSync(join(repoRoot, "LICENSE"));
const workspace = readWorkspace(repoRoot);
const pub = workspace.filter((p) => p.json.private !== true);

describe("workspace packages", () => {
  it("has the ten public packages and a private extension", () => {
    assert.deepEqual(
      publicDirs(repoRoot),
      ["backend", "cli", "compiler", "env", "eslint-plugin", "ir", "lsp", "runtime", "stubgen", "testkit"],
    );
    const vscode = workspace.find((p) => p.dir === "vscode");
    assert.ok(vscode !== undefined);
    assert.equal(vscode.json.private, true);
  });

  for (const p of pub) {
    it(`${p.json.name} has the npm metadata`, () => {
      const j = p.json;
      assert.equal(typeof j.description, "string");
      assert.ok(j.description.length > 10);
      assert.equal(j.license, "MIT");
      assert.equal(j.repository?.type, "git");
      assert.match(j.repository.url, /^git\+https:\/\/github\.com\/[^/]+\/abf-blueprint-ts\.git$/);
      assert.equal(j.repository.directory, `packages/${p.dir}`);
      assert.match(j.homepage, /^https:\/\/github\.com\/[^/]+\/abf-blueprint-ts#readme$/);
      assert.match(j.bugs?.url, /^https:\/\/github\.com\/[^/]+\/abf-blueprint-ts\/issues$/);
      assert.equal(j.engines?.node, ">=24");
      assert.equal(j.publishConfig?.access, "public");
      assert.ok(j.files.includes("dist/src/**/*.js"));
      assert.ok(j.files.includes("dist/src/**/*.d.ts"));
      assert.ok(!j.files.includes("dist/src"), "no bare dist/src (it would ship source maps)");
      assert.ok(!j.files.some((f) => f.includes("test")), "no tests");
    });

    it(`${p.json.name} ships LICENSE and README.md`, () => {
      assert.ok(readFileSync(join(repoRoot, "packages", p.dir, "LICENSE")).equals(rootLicense), "LICENSE is a copy of the root LICENSE");
      assert.ok(readFileSync(join(repoRoot, "packages", p.dir, "README.md"), "utf8").trim().length > 40);
    });
  }

  it("release/allowlist.json lists every public package under npm and the vsix entries", () => {
    const allow = JSON.parse(readFileSync(join(repoRoot, "release", "allowlist.json"), "utf8"));
    assert.deepEqual(Object.keys(allow.npm).sort(), pub.map((p) => p.json.name).sort());
    for (const patterns of Object.values(allow.npm)) {
      assert.ok(patterns.every((p) => !p.endsWith(".map")), "no source maps");
      assert.ok(patterns.includes("LICENSE") && patterns.includes("README.md") && patterns.includes("package.json"));
    }
    assert.ok(Array.isArray(allow.vsix) && allow.vsix.includes("extension/dist/extension.js"));
  });

  it("all packages are at the cli version (lockstep)", () => {
    const cli = JSON.parse(readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8")).version;
    assert.deepEqual(checkVersions(repoRoot, cli), []);
  });
});
