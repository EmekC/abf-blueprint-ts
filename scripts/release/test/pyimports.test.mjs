// Regression guard: a vendored backend .py must not import a local module that the allowlist leaves out
// (the 1.0.0 build shipped without fscopy.py / tagsini.py and the bundled backend died on import).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadAllowlist } from "../lib/allowlist.mjs";
import { vendorBackend } from "../lib/backend.mjs";
import { assertNoMissingLocalImports, findMissingLocalImports, parseImports } from "../lib/pyimports.mjs";
import { loadPins } from "../lib/pins.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const buf = (s) => Buffer.from(s, "utf8");

describe("parseImports", () => {
  it("reads import and from-import lines, including lazy, aliased, multi-name and parenthesised ones", () => {
    const src = [
      "import os, fscopy as fs, json",
      "from pathlib import Path",
      "from tagsini import (",
      "    a,  # comment",
      "    b,",
      ")",
      "def f():",
      "    import staging",
      "    from . import core, t3d",
      "    from .core import LIB",
      "# import notreal",
    ].join("\n");
    const got = parseImports(src).map((i) => `${i.level}:${i.module}:${i.names.join("+")}`);
    assert.deepEqual(got, ["0:os:", "0:fscopy:", "0:json:", "0:pathlib:Path", "0:tagsini:a+b", "0:staging:", "1::core+t3d", "1:core:LIB"]);
  });
});

describe("findMissingLocalImports", () => {
  const all = ["server.py", "helper.py", "fscopy.py", "editor/pkg/__init__.py", "editor/pkg/a.py", "editor/pkg/b.py", "editor/top.py", "tests/t.py"];

  it("passes when every local import is vendored and ignores stdlib / third-party modules", () => {
    const vendored = new Map([
      ["server.py", buf("import os\nimport requests\nimport helper\nfrom fscopy import copy\n")],
      ["helper.py", buf("import json\n")],
      ["fscopy.py", buf("import shutil\n")],
    ]);
    assert.deepEqual(findMissingLocalImports(vendored, all), []);
    assert.doesNotThrow(() => assertNoMissingLocalImports(vendored, all));
  });

  it("reports a local module the vendored set lacks", () => {
    const vendored = new Map([["server.py", buf("import helper\nimport fscopy\n")], ["helper.py", buf("x = 1\n")]]);
    const gaps = findMissingLocalImports(vendored, all);
    assert.deepEqual(gaps.map((g) => `${g.file} -> ${g.missing}`), ["server.py -> fscopy.py"]);
    assert.throws(() => assertNoMissingLocalImports(vendored, all), /server\.py imports fscopy -> fscopy\.py/);
  });

  it("finds lazy imports, relative imports and submodules of local packages", () => {
    const vendored = new Map([
      ["editor/top.py", buf("def f():\n    from pkg import a\n    import pkg.b\n")],
      ["editor/pkg/__init__.py", buf("")],
      ["editor/pkg/a.py", buf("from . import b\n")],
    ]);
    const gaps = findMissingLocalImports(vendored, all).map((g) => `${g.file} -> ${g.missing}`);
    assert.deepEqual(gaps, ["editor/pkg/a.py -> editor/pkg/b.py", "editor/top.py -> editor/pkg/b.py"]);
  });

  it("does not look at non-Python files", () => {
    assert.deepEqual(findMissingLocalImports(new Map([["README.md", buf("import helper\n")]]), all), []);
  });
});

describe("the pinned backend", () => {
  // The release build checks the same thing in vendorBackend; this runs it in the unit tests when a checkout of the pinned commit
  // is at ABFC_BACKEND_REPO or build/backend-src (CI checks it out for the artifacts job).
  const repo = process.env.ABFC_BACKEND_REPO ?? join(root, "build", "backend-src");
  const pins = loadPins(join(root, "release", "pins.json"));
  const have =
    existsSync(join(repo, ".git")) &&
    spawnSync("git", ["-C", repo, "cat-file", "-e", `${pins.backend.commit}^{commit}`], { windowsHide: true }).status === 0;

  it("vendors every local module its files import, with the committed allowlist", { skip: have ? false : "no checkout of the pinned backend commit" }, () => {
    const allow = loadAllowlist(join(root, "release", "allowlist.json"));
    const v = vendorBackend({ repoDir: repo, commit: pins.backend.commit, version: pins.backend.version, patterns: allow.backend });
    for (const name of ["server.py", "headless_tools.py", "fscopy.py", "tagsini.py", "editor/bpkit/assetops.py", "editor/bpkit/tags.py"]) {
      assert.ok(v.files.has(name), `${name} is not vendored`);
    }
    assert.equal(v.filesSha256, pins.backend.filesSha256);
  });
});
