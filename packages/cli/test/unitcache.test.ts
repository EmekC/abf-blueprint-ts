import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newLock } from "@abfc/stubgen";
import type { StubsLock } from "@abfc/stubgen";
import { dropUnitCacheAsset, readUnitCache, stubLockHashOf, writeUnitCache } from "../src/unitcache.js";

function lock(over: Partial<StubsLock> = {}): StubsLock {
  return {
    ...newLock({
      profile: "ue-test",
      engineVersion: "5.4.4",
      modEditorVersion: "1.0",
      editorFingerprint: "f".repeat(64),
      filterContentVersion: null,
      classes: ["/Game/A"],
      scriptClasses: ["/Script/X.A"],
      modAssets: ["/TestMod/B"],
      createdAt: "2026-01-02T00:00:00.000Z",
    }),
    ...over,
  };
}

test("the stub lock hash ignores the class lists and the timestamp", () => {
  const base = stubLockHashOf(lock());
  assert.equal(stubLockHashOf(lock({ classes: ["/Game/A", "/Game/B"] })), base);
  // Adding classes automatically (lock.auto) never re-plans a unit.
  const auto = { catalogSha256: "a", gameClasses: 3000, failed: [], added: [] };
  assert.equal(stubLockHashOf(lock({ auto })), base);
  assert.equal(stubLockHashOf(lock({ auto: { ...auto, catalogSha256: "b", gameClasses: 1, failed: ["/Game/X"], added: ["/Script/Y.Z"] } })), base);
  assert.equal(stubLockHashOf(lock({ scriptClasses: [] })), base);
  assert.equal(stubLockHashOf(lock({ modAssets: ["/TestMod/B", "/TestMod/C"] })), base);
  assert.equal(stubLockHashOf(lock({ createdAt: "2027-01-01T00:00:00.000Z" })), base);
});

test("the stub lock hash follows the generator and the editor identity", () => {
  const base = stubLockHashOf(lock());
  assert.notEqual(stubLockHashOf(lock({ generator: "other-generator" })), base);
  assert.notEqual(stubLockHashOf(lock({ editorFingerprint: "0".repeat(64) })), base);
  assert.notEqual(stubLockHashOf(lock({ engineVersion: "5.5.0" })), base);
  assert.notEqual(stubLockHashOf(lock({ modEditorVersion: "2.0" })), base);
  assert.notEqual(stubLockHashOf(lock({ filterContentVersion: "7" })), base);
  assert.equal(stubLockHashOf(null), "no-lock");
});

test("dropUnitCacheAsset forgets one asset and leaves the others", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-cache-"));
  try {
    const file = join(dir, "cache", "units.json");
    const entry = { irHash: "sha256:a", stubLockHash: "h", compilerVersion: "c" };
    writeUnitCache(file, { "/TestMod/A": { "event:X": entry }, "/TestMod/B": { "event:Y": entry } });
    dropUnitCacheAsset(file, "/TestMod/A");
    dropUnitCacheAsset(file, "/TestMod/Nothing");
    assert.deepEqual(Object.keys(readUnitCache(file)), ["/TestMod/B"]);
    assert.ok(readFileSync(file, "utf8").endsWith("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
