import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLibDir, useTypeScriptLibDir } from "../src/index.js";

const norm = (p: string): string => p.replaceAll("\\", "/");

test("useTypeScriptLibDir redirects TypeScript's lib folder and restores it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-tslib-"));
  const before = norm(defaultLibDir());
  const restore = useTypeScriptLibDir(() => tmp);
  try {
    assert.equal(norm(defaultLibDir()), norm(tmp));
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
  assert.equal(norm(defaultLibDir()), before);
  assert.ok(norm(defaultLibDir()).endsWith("node_modules/typescript/lib"), defaultLibDir());
});

test("useTypeScriptLibDir asks for the folder lazily, on each lookup", () => {
  let calls = 0;
  const restore = useTypeScriptLibDir(() => {
    calls++;
    return "C:\\lazy";
  });
  try {
    assert.equal(calls, 0);
    defaultLibDir();
    assert.ok(calls >= 1);
  } finally {
    restore();
  }
});
