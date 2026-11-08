import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProjectLock, lockFileOf } from "../src/lock.js";

function withProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "abfc-lock-"));
  try {
    mkdirSync(join(dir, ".abfc"), { recursive: true });
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lockText = (pid: number, command: string, startedAt: string): string => JSON.stringify({ pid, command, startedAt }, null, 2) + "\n";
const leftovers = (dir: string): string[] => readdirSync(join(dir, ".abfc")).filter((f) => f.endsWith(".stale"));

test("a stale lock is claimed by rename and replaced; no claim file is left", () => {
  withProject((dir) => {
    writeFileSync(lockFileOf(dir), lockText(424242, "build", "2026-01-01T00:00:00.000Z"), "utf8");
    const lock = acquireProjectLock(dir, "status", new Date("2026-01-02T00:00:00.000Z"), (pid) => pid !== 424242);
    assert.ok(lock !== null);
    assert.equal(JSON.parse(readFileSync(lockFileOf(dir), "utf8")).command, "status");
    assert.deepEqual(leftovers(dir), []);
    lock.release();
  });
});

test("a lock another run created while this run judged the old one stale is never removed", () => {
  withProject((dir) => {
    const file = lockFileOf(dir);
    writeFileSync(file, lockText(424242, "build", "2026-01-01T00:00:00.000Z"), "utf8");
    const fresh = lockText(515151, "publish", "2026-01-02T00:00:00.000Z");
    let raced = false;
    // The other run replaces the stale lock after this run read it and before this run claims it.
    const alive = (pid: number): boolean => {
      if (pid === 424242) {
        if (!raced) {
          raced = true;
          rmSync(file, { force: true });
          writeFileSync(file, fresh, "utf8");
        }
        return false;
      }
      return true;
    };
    assert.throws(
      () => acquireProjectLock(dir, "build", new Date("2026-01-02T00:00:01.000Z"), alive),
      (e: unknown) => String((e as { message?: string }).message ?? e).includes("process 515151"),
    );
    assert.equal(readFileSync(file, "utf8"), fresh, "the other run's lock is still in place");
    assert.deepEqual(leftovers(dir), []);
  });
});
