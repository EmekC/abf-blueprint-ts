import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { applyVersion, checkVersions, publicDirs, readWorkspace } from "../lib/versions.mjs";

const tmp = mkdtempSync(join(tmpdir(), "abfc-rel-ver-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const writeJson = (file, json) => writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);

/** A fake repo: two public packages (cli depends on core), one private package, a lock and version.ts. */
function fakeRepo(name) {
  const root = join(tmp, name);
  const pk = (dir, json) => {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeJson(join(root, "packages", dir, "package.json"), json);
  };
  pk("core", { name: "@abfc/core", version: "0.1.0", license: "MIT", dependencies: { zod: "1.2.3" } });
  pk("cli", { name: "@abfc/cli", version: "0.1.0", license: "MIT", dependencies: { "@abfc/core": "0.1.0" }, devDependencies: { "@abfc/core": "0.1.0" } });
  pk("ext", { name: "ext", version: "0.1.0", private: true });
  mkdirSync(join(root, "packages", "cli", "src"), { recursive: true });
  writeFileSync(join(root, "packages", "cli", "src", "version.ts"), '/** v */\nexport const ABFC_VERSION = "0.1.0";\n');
  writeJson(join(root, "package-lock.json"), {
    name: "fake",
    lockfileVersion: 3,
    packages: {
      "": { name: "fake" },
      "node_modules/@abfc/core": { resolved: "packages/core", link: true },
      "packages/core": { name: "@abfc/core", version: "0.1.0", dependencies: { zod: "1.2.3" } },
      "packages/cli": { name: "@abfc/cli", version: "0.1.0", dependencies: { "@abfc/core": "0.1.0" } },
      "packages/ext": { name: "ext", version: "0.1.0" },
    },
  });
  return root;
}

describe("versions", () => {
  it("apply then check returns no mismatches", () => {
    const root = fakeRepo("apply");
    assert.ok(checkVersions(root, "1.2.3").length > 0);
    const r = applyVersion(root, "1.2.3", { write: true });
    assert.ok(r.changed.includes("packages/cli/package.json"));
    assert.ok(r.changed.includes("package-lock.json"));
    assert.ok(r.changed.includes("packages/cli/src/version.ts"));
    assert.deepEqual(checkVersions(root, "1.2.3"), []);
    const cli = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
    assert.equal(cli.version, "1.2.3");
    assert.equal(cli.dependencies["@abfc/core"], "1.2.3");
    assert.equal(cli.devDependencies["@abfc/core"], "1.2.3");
    const core = JSON.parse(readFileSync(join(root, "packages", "core", "package.json"), "utf8"));
    assert.equal(core.dependencies.zod, "1.2.3", "third-party ranges are untouched");
    assert.deepEqual(Object.keys(cli), ["name", "version", "license", "dependencies", "devDependencies"], "key order is kept");
    assert.match(readFileSync(join(root, "packages", "cli", "src", "version.ts"), "utf8"), /ABFC_VERSION = "1\.2\.3";\n$/);
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["packages/cli"].version, "1.2.3");
    assert.equal(lock.packages["packages/cli"].dependencies["@abfc/core"], "1.2.3");
    assert.deepEqual(lock.packages["node_modules/@abfc/core"], { resolved: "packages/core", link: true });
  });

  it("a second apply changes nothing", () => {
    const root = fakeRepo("idem");
    applyVersion(root, "1.2.3", { write: true });
    assert.deepEqual(applyVersion(root, "1.2.3", { write: true }).changed, []);
  });

  it("write:false reports without writing", () => {
    const root = fakeRepo("dry");
    const r = applyVersion(root, "2.0.0", { write: false });
    assert.ok(r.changed.length > 0);
    assert.ok(checkVersions(root, "0.1.0").length === 0, "nothing was written");
  });

  it("check lists each mismatch", () => {
    const root = fakeRepo("mismatch");
    applyVersion(root, "1.2.3", { write: true });
    const f = join(root, "packages", "core", "package.json");
    const json = JSON.parse(readFileSync(f, "utf8"));
    json.version = "1.2.4";
    writeJson(f, json);
    writeFileSync(join(root, "packages", "cli", "src", "version.ts"), 'export const ABFC_VERSION = "9.9.9";\n');
    const problems = checkVersions(root, "1.2.3");
    assert.ok(problems.some((p) => p.includes("packages/core/package.json") && p.includes("1.2.4")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("version.ts") && p.includes("9.9.9")), problems.join("\n"));
  });

  it("public dirs exclude private packages", () => {
    const root = fakeRepo("public");
    assert.deepEqual(publicDirs(root), ["cli", "core"]);
    assert.deepEqual(readWorkspace(root).map((p) => p.dir), ["cli", "core", "ext"]);
  });
});
