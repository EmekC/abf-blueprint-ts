import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkManifest, checkPackFiles, publishOrder } from "../lib/npm.mjs";

describe("publishOrder", () => {
  it("puts dependencies first and breaks ties by name", () => {
    const order = publishOrder([
      { name: "@x/cli", deps: ["@x/lsp", "@x/ir", "left-pad"] },
      { name: "@x/lsp", deps: ["@x/ir", "@x/env"] },
      { name: "@x/env", deps: ["@x/ir"] },
      { name: "@x/ir", deps: [] },
      { name: "@x/alpha", deps: [] },
    ]);
    assert.deepEqual(order, ["@x/alpha", "@x/ir", "@x/env", "@x/lsp", "@x/cli"]);
  });

  it("orders independent packages by name", () => {
    assert.deepEqual(
      publishOrder([
        { name: "b", deps: [] },
        { name: "c", deps: [] },
        { name: "a", deps: [] },
      ]),
      ["a", "b", "c"],
    );
  });

  it("throws on a cycle and names the packages", () => {
    assert.throws(
      () =>
        publishOrder([
          { name: "a", deps: ["b"] },
          { name: "b", deps: ["a"] },
          { name: "c", deps: [] },
        ]),
      /cycle among: a, b/,
    );
  });
});

describe("checkPackFiles", () => {
  const patterns = ["package.json", "README.md", "LICENSE", "dist/src/**.js", "dist/src/**.d.ts"];
  const good = ["package.json", "README.md", "LICENSE", "dist/src/index.js", "dist/src/index.d.ts", "dist/src/sub/a.js"];

  it("accepts the allowed files", () => {
    assert.deepEqual(checkPackFiles("@x/a", good, patterns), []);
  });

  it("rejects a source map", () => {
    const problems = checkPackFiles("@x/a", [...good, "dist/src/index.js.map"], patterns);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /dist\/src\/index\.js\.map.*not on the npm allowlist/);
  });

  it("rejects test output", () => {
    const problems = checkPackFiles("@x/a", [...good, "dist/test/a.test.js"], patterns);
    assert.equal(problems.length, 1);
  });

  it("reports an allowlist entry that matches nothing", () => {
    const problems = checkPackFiles("@x/a", good.filter((p) => p !== "LICENSE"), patterns);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /LICENSE matches no packed file/);
  });
});

describe("checkManifest", () => {
  const ok = {
    name: "@x/cli",
    version: "1.0.0",
    repository: { type: "git", url: "git+https://example.invalid/r.git", directory: "packages/cli" },
    dependencies: { "@abfc/ir": "1.0.0", typescript: "6.0.3" },
  };

  it("accepts a clean manifest", () => {
    assert.deepEqual(checkManifest(ok, "1.0.0"), []);
  });

  it("refuses file:, link: and workspace: dependencies", () => {
    for (const range of ["file:../ir", "link:../ir", "workspace:*"]) {
      const problems = checkManifest({ ...ok, dependencies: { ...ok.dependencies, other: range } }, "1.0.0");
      assert.equal(problems.length, 1, range);
      assert.match(problems[0], /local reference/);
    }
  });

  it("refuses an @abfc dependency that is not the version", () => {
    const problems = checkManifest({ ...ok, dependencies: { "@abfc/ir": "0.1.0" } }, "1.0.0");
    assert.equal(problems.length, 1);
    assert.match(problems[0], /expected 1\.0\.0/);
  });

  it("refuses private packages, a wrong version and a missing repository.directory", () => {
    assert.equal(checkManifest({ ...ok, private: true }, "1.0.0").length, 1);
    assert.equal(checkManifest({ ...ok, dependencies: {} }, "1.0.1").length, 1);
    assert.equal(checkManifest({ ...ok, repository: { type: "git", url: "u" } }, "1.0.0").length, 1);
  });
});
