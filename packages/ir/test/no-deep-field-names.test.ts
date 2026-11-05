import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// The forbidden words are assembled from pieces so this file does not trip its own guard.
const FORBIDDEN = [["abi", "otic"], ["deployed", "_"], ["good", "soup"], ["soup", "info"], ["global", "item"]].map((p) => p.join(""));

function repoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "packages")) && existsSync(join(dir, "package.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("repository root (a folder with packages/ and package.json) not found above " + process.cwd());
    dir = up;
  }
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
}

test("package tests contain no game-specific names", () => {
  const root = repoRoot();
  const files: string[] = [];
  for (const pkg of readdirSync(join(root, "packages"))) {
    const testDir = join(root, "packages", pkg, "test");
    if (existsSync(testDir)) walk(testDir, files);
  }
  assert.ok(files.length > 0, "expected at least this guard test under packages/*/test");
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8").toLowerCase();
    for (const w of FORBIDDEN) if (text.includes(w)) hits.push(`${f}: ${w}`);
  }
  assert.deepEqual(hits, []);
});
