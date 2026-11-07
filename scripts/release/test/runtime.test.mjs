import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readZip } from "@abfc/env";
import { packageDirsFromMetafile, noticesText } from "../lib/notices.mjs";
import { sha256Buf } from "../lib/pins.mjs";
import { buildRuntimeZip, checkNoBuildPathsInBinary, checkNoUserPaths, collectRuntimeFiles } from "../lib/runtime.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "abfc-rel-runtime-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("buildRuntimeZip", () => {
  it("manifest matches the zip content, entries are sorted and the output is deterministic", () => {
    const files = new Map([
      ["python/python.exe", Buffer.from("MZ")],
      ["backend/server.py", Buffer.from("SERVER_VERSION = 1\n")],
      ["data/descriptions.json", Buffer.from("{}")],
    ]);
    const a = buildRuntimeZip(files, "1.2.3");
    const b = buildRuntimeZip(new Map([...files].reverse()), "1.2.3");
    assert.equal(sha256Buf(a.zip), sha256Buf(b.zip));
    assert.equal(a.manifest.schemaVersion, 1);
    assert.equal(a.manifest.abfcVersion, "1.2.3");
    assert.equal(a.manifest.zipSha256, sha256Buf(a.zip));
    const entries = readZip(a.zip);
    assert.deepEqual(entries.map((e) => e.name), ["backend/server.py", "data/descriptions.json", "python/python.exe"]);
    assert.deepEqual(Object.keys(a.manifest.files).sort(), entries.map((e) => e.name));
    for (const e of entries) {
      const data = e.read();
      assert.deepEqual(a.manifest.files[e.name], { size: data.length, sha256: sha256Buf(data) });
    }
  });
});

describe("checkNoUserPaths", () => {
  it("flags user profile paths in text files only", () => {
    assert.throws(() => checkNoUserPaths("a.py", Buffer.from('p = "C:\\Users\\jane\\x"')), /user path/);
    assert.throws(() => checkNoUserPaths("a.json", Buffer.from('"c:/users/jane/x"')), /user path/);
    assert.doesNotThrow(() => checkNoUserPaths("a.txt", Buffer.from("C:\\Users\\Public\\x")));
    assert.doesNotThrow(() => checkNoUserPaths("a.py", Buffer.from("nothing here")));
    assert.doesNotThrow(() => checkNoUserPaths("a.exe", Buffer.from("C:\\Users\\jane\\x")));
  });
});

describe("checkNoBuildPathsInBinary", () => {
  it("finds user paths and .claude folders as latin1 and utf16le text at either alignment", () => {
    const user = "C:\\Users\\jane\\proj\\abfc.cjs";
    assert.throws(() => checkNoBuildPathsInBinary("abfc.exe", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(user, "latin1")])), /build path as latin1/);
    assert.throws(() => checkNoBuildPathsInBinary("abfc.exe", Buffer.concat([Buffer.from([0, 1]), Buffer.from(user, "utf16le")])), /as utf16le/);
    assert.throws(() => checkNoBuildPathsInBinary("abfc.exe", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(user, "utf16le")])), /as utf16le/);
    assert.throws(() => checkNoBuildPathsInBinary("x.dll", Buffer.from("..\\.claude\\worktrees\\a", "latin1")), /\.claude/);
    for (const n of [1, 2, 3, 6057, 6058]) assert.doesNotThrow(() => checkNoBuildPathsInBinary("a.py", Buffer.from("x".repeat(n))));
    assert.doesNotThrow(() => checkNoBuildPathsInBinary("abfc.exe", Buffer.from("C:\\Users\\Public\\x \u0000\u0001 build\\release\\work\\abfc.cjs")));
  });
});

describe("collectRuntimeFiles", () => {
  it("collects the data files of the repo layout without sourceMappingURL lines", () => {
    // Needs a built repo (npm run build), which the test run always has.
    const files = collectRuntimeFiles({
      repoRoot,
      backendFiles: new Map([["server.py", Buffer.from("x")]]),
      pythonFiles: new Map([["python/python.exe", Buffer.from("MZ")]]),
      notices: "notices",
    });
    const names = [...files.keys()];
    for (const n of [
      "backend/server.py",
      "python/python.exe",
      "data/descriptions.json",
      "schema/abf.config.schema.json",
      "THIRD-PARTY-NOTICES.txt",
      "types/runtime/index.d.ts",
      "types/testkit/index.d.ts",
      "types/ir/index.d.ts",
      "tslib/lib.es5.d.ts",
    ]) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.ok(names.some((n) => /^profiles\/.+\.json$/.test(n)));
    for (const n of names.filter((x) => x.startsWith("types/"))) {
      assert.ok(!files.get(n).toString("utf8").includes("sourceMappingURL"), `${n} still has a sourceMappingURL`);
    }
  });
});

describe("notices", () => {
  it("lists package dirs from a metafile (deepest node_modules segment, scoped names)", () => {
    const dirs = packageDirsFromMetafile(
      {
        inputs: {
          "packages/cli/dist/src/exe.js": {},
          "node_modules/typescript/lib/typescript.js": {},
          "node_modules/@scope/pkg/dist/a.js": {},
          "node_modules/a/node_modules/b/index.js": {},
          "node_modules/typescript/lib/other.js": {},
        },
      },
      tmp,
    );
    assert.deepEqual(
      dirs,
      [
        resolve(tmp, "node_modules/@scope/pkg"),
        resolve(tmp, "node_modules/a/node_modules/b"),
        resolve(tmp, "node_modules/typescript"),
      ].sort(),
    );
  });

  it("builds the text and names a package without a license file", () => {
    const withLicense = join(tmp, "node_modules", "good");
    mkdirSync(withLicense, { recursive: true });
    writeFileSync(join(withLicense, "package.json"), JSON.stringify({ name: "good", version: "1.0.0", license: "MIT" }));
    writeFileSync(join(withLicense, "LICENSE"), "good license text\n");
    const without = join(tmp, "node_modules", "bad");
    mkdirSync(without, { recursive: true });
    writeFileSync(join(without, "package.json"), JSON.stringify({ name: "bad", version: "2.0.0", license: "MIT" }));

    const text = noticesText({
      packages: [withLicense],
      extras: [{ name: "Node.js", version: "26.7.0", license: "MIT", text: "node license\n" }],
    });
    assert.ok(text.startsWith("abfc third-party notices"));
    assert.ok(text.includes("== Node.js 26.7.0 (MIT) =="));
    assert.ok(text.includes("== good 1.0.0 (MIT) =="));
    assert.ok(text.includes("good license text"));
    assert.throws(() => noticesText({ packages: [without], extras: [] }), /bad/);
  });
});
