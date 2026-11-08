import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { globToRegExp, loadAllowlist, selectAllowed } from "../lib/allowlist.mjs";

const tmp = mkdtempSync(join(tmpdir(), "abfc-rel-allow-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("allowlist", () => {
  it("loads the file", () => {
    const f = join(tmp, "a.json");
    writeFileSync(f, JSON.stringify({ schemaVersion: 1, zip: ["abfc.exe"] }));
    assert.deepEqual(loadAllowlist(f), { schemaVersion: 1, zip: ["abfc.exe"] });
  });

  it("globToRegExp table", () => {
    const table = [
      ["server.py", "server.py", true],
      ["server.py", "serverXpy", false],
      ["server.py", "Server.py", false],
      ["editor/**", "editor/a.py", true],
      ["editor/**", "editor/sub/b.py", true],
      ["editor/**", "editor", false],
      ["profiles/*.json", "profiles/x.json", true],
      ["profiles/*.json", "profiles/sub/x.json", false],
      ["tslib/lib*.d.ts", "tslib/lib.es5.d.ts", true],
      ["tslib/lib*.d.ts", "tslib/other.d.ts", false],
      ["abfc-vscode-*.vsix", "abfc-vscode-0.1.0.vsix", true],
      ["a?c", "abc", true],
      ["a?c", "a/c", false],
      ["a.b", "axb", false],
    ];
    for (const [glob, path, expected] of table) {
      assert.equal(globToRegExp(glob).test(path), expected, `${glob} vs ${path}`);
    }
  });

  it("selectAllowed reports unmatched patterns and rejected paths", () => {
    const r = selectAllowed(["server.py", "editor/a.py", "tests/t.py"], ["server.py", "editor/**", "LICENSE"]);
    assert.deepEqual(r.selected, ["server.py", "editor/a.py"]);
    assert.deepEqual(r.unmatchedPatterns, ["LICENSE"]);
    assert.deepEqual(r.rejected, ["tests/t.py"]);
  });
});
