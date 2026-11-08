import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { vendorBackend } from "../lib/backend.mjs";

const tmp = mkdtempSync(join(tmpdir(), "abfc-rel-backend-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function git(...args) {
  const r = spawnSync("git", ["-C", tmp, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function put(rel, text) {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

let commit = "";

before(() => {
  git("init", "-q");
  put("server.py", 'SERVER_VERSION = "9.9.9"\nprint("hi")\n');
  put("editor/a.py", "A = 1\n");
  put("data/x.txt", "game data\n");
  put("tests/t.py", "T = 1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  commit = git("rev-parse", "HEAD");
});

describe("vendorBackend", () => {
  const patterns = ["server.py", "editor/**"];

  it("selects only allowlisted files and hashes them stably", () => {
    const a = vendorBackend({ repoDir: tmp, commit, version: "9.9.9", patterns });
    assert.deepEqual([...a.files.keys()].sort(), ["editor/a.py", "server.py"]);
    assert.match(a.filesSha256, /^[0-9a-f]{64}$/);
    const b = vendorBackend({ repoDir: tmp, commit, version: "9.9.9", patterns });
    assert.equal(b.filesSha256, a.filesSha256);
    assert.equal(a.files.get("editor/a.py").toString("utf8").replace(/\r\n/g, "\n"), "A = 1\n");
  });

  it("throws on a wrong SERVER_VERSION", () => {
    assert.throws(() => vendorBackend({ repoDir: tmp, commit, version: "1.0.0", patterns }), /SERVER_VERSION is 9\.9\.9/);
  });

  it("throws when a pattern matches nothing", () => {
    assert.throws(() => vendorBackend({ repoDir: tmp, commit, version: "9.9.9", patterns: [...patterns, "LICENSE"] }), /matched nothing/);
  });

  it("throws on an unknown or abbreviated commit", () => {
    assert.throws(() => vendorBackend({ repoDir: tmp, commit: "0".repeat(40), version: "9.9.9", patterns }));
    assert.throws(() => vendorBackend({ repoDir: tmp, commit: commit.slice(0, 10), version: "9.9.9", patterns }), /commit mismatch/);
  });
});
