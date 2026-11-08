import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { win32 } from "node:path";
import { AbfcError } from "@abfc/env";

/** Commands that change or read the stage or the manifests and therefore run one at a time per project (ABFC4019). */
export const LOCKED_COMMANDS: readonly string[] = ["build", "test", "publish", "status", "stubs", "adopt"];

/** A lock older than this is replaced even when its process id is alive (the id may have been reused after a crash). */
export const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** An unreadable lock file younger than this is a lock that is still being written. */
const UNREADABLE_GRACE_MS = 30 * 1000;

export interface LockInfo {
  pid: number;
  command: string;
  startedAt: string;
}

export function lockFileOf(projectDir: string): string {
  return win32.join(projectDir, ".abfc", "lock.json");
}

/** True when a process with this id exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): { info: LockInfo | null; ageMs: number } | null {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(file, "utf8");
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const ageMs = Math.max(0, Date.now() - mtimeMs);
  try {
    const j = JSON.parse(text) as Partial<LockInfo>;
    if (typeof j.pid === "number" && typeof j.command === "string" && typeof j.startedAt === "string") {
      return { info: { pid: j.pid, command: j.command, startedAt: j.startedAt }, ageMs };
    }
  } catch {
    // unreadable: handled by the caller through `info: null`
  }
  return { info: null, ageMs };
}

export interface ProjectLock {
  release(): void;
}

/**
 * Takes `<project>/.abfc/lock.json` for one command (created with the exclusive flag, removed by `release`). Returns
 * null when the project folder is not on the real file system (the synthetic machines of tests) or the lock cannot be
 * created for another reason: a lock that cannot be written must not stop a build. Throws ABFC4019 when another abfc
 * run holds the lock. A lock of a dead process, older than {@link LOCK_MAX_AGE_MS}, or unreadable for more than a
 * few seconds is replaced.
 */
export function acquireProjectLock(
  projectDir: string,
  command: string,
  now: Date,
  alive: (pid: number) => boolean = pidAlive,
): ProjectLock | null {
  if (!existsSync(projectDir)) return null;
  const file = lockFileOf(projectDir);
  try {
    mkdirSync(win32.dirname(file), { recursive: true });
  } catch {
    return null;
  }
  const mine: LockInfo = { pid: process.pid, command, startedAt: now.toISOString() };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, JSON.stringify(mine, null, 2) + "\n");
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        process.removeListener("exit", release);
        const cur = readLock(file);
        // Only remove our own lock: a replaced one belongs to the run that replaced it.
        if (cur !== null && cur.info !== null && cur.info.pid === mine.pid && cur.info.startedAt === mine.startedAt) {
          try {
            rmSync(file, { force: true });
          } catch {
            // best effort
          }
        }
      };
      process.once("exit", release);
      return { release };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    const cur = readLock(file);
    if (cur === null) continue; // removed meanwhile: try again
    const info = cur.info;
    const stale =
      info === null ? cur.ageMs > UNREADABLE_GRACE_MS : !alive(info.pid) || cur.ageMs > LOCK_MAX_AGE_MS;
    if (!stale) {
      const who = info === null ? "another abfc run" : `another abfc ${info.command}`;
      const where = info === null ? "" : ` (process ${info.pid}, since ${info.startedAt})`;
      throw new AbfcError({
        severity: "error",
        code: "ABFC4019",
        message: `${who} is running in this project${where}. Two runs at once would write the same staged copy and manifests.`,
        fix: "wait until that run has finished, then run the command again. If no abfc is running (for example after a crash of the whole machine), delete .abfc/lock.json.",
      });
    }
    // Claim the stale file by renaming it away: of two runs that judged the same stale lock only one rename succeeds, so a lock the
    // other run created meanwhile is never removed by this one.
    const claimed = `${file}.${process.pid}.stale`;
    try {
      renameSync(file, claimed);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // someone else took it: try again
      return null;
    }
    const got = readLock(claimed);
    const same =
      got !== null &&
      (info === null ? got.info === null : got.info !== null && got.info.pid === info.pid && got.info.startedAt === info.startedAt);
    if (same) {
      try {
        rmSync(claimed, { force: true });
      } catch {
        // best effort
      }
      continue;
    }
    // Not the lock judged stale (a fresh one was created in between): put it back when the lock path is free, else it is held.
    try {
      linkSync(claimed, file);
    } catch {
      // the path is taken (EEXIST) by yet another lock, or the restore is not possible: the next attempt reads whatever is there
    }
    try {
      rmSync(claimed, { force: true });
    } catch {
      // best effort
    }
  }
  return null;
}
