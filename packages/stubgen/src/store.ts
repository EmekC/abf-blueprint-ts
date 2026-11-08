// The stub folder `.abfc/stubs/<profile>/` as a set of files written one by one and atomically (auto stubs).
// The writer is serialized by the project lock (`.abfc/lock.json`), which every `abfc stubs` and `abfc build` holds.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { LOCK_FILE, writeLock } from "./lock.js";
import type { StubsLock } from "./lock.js";
import type { ManualAsset } from "./manual.js";
import type { ReflectData } from "./types.js";

export const CACHE_FILE = "_cache.json.gz";
export const COVERAGE_FILE = "_coverage.json";
export const LIBRARY_FILE = "_library.json";
export const NAMES_FILE = "_names.json";
const INDEX_FILE = "_index.json";
const RETIRED_FILE = "retired.json";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Writes `data` to `${file}.${pid}.tmp` and renames it over `file`. Windows refuses a rename over a file another process (tsserver)
 * has open at that moment: EPERM, EBUSY and EACCES are retried up to 6 times, sleeping 25, 50, 100 ... ms. A final failure removes the
 * temporary file and throws.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  if (typeof data === "string") writeFileSync(tmp, data, "utf8");
  else writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || i >= 5) {
        try {
          unlinkSync(tmp);
        } catch {
          // already gone
        }
        throw e;
      }
      sleepMs(25 * 2 ** i);
    }
  }
}

/** What a stub run keeps so the next run can reflect only the classes that are new. */
export interface StubCache {
  version: 1;
  generator: string;
  editorFingerprint: string;
  reflect: ReflectData;
  filter: { contentVersion: string | null; rules: Array<["Allow" | "Block", string]> };
  manual: ManualAsset[];
}

/** The cache of the profile folder; null when missing, unreadable or of another version. */
export function readStubCache(profileDir: string): StubCache | null {
  try {
    const parsed = JSON.parse(gunzipSync(readFileSync(join(profileDir, CACHE_FILE))).toString("utf8")) as StubCache;
    return parsed !== null && typeof parsed === "object" && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Which names the stubs already hold: answers "is X in the stubs" without parsing the cache. */
export interface StubCoverage {
  version: 1;
  /** Classes (without `castOnly`) and structs with members. */
  reflected: string[];
  /** `reflected` plus cast-only classes and opaque types (an opaque enum is complete). */
  declared: string[];
  errors: string[];
}

export function coverageOf(data: ReflectData, opaque: string[], errors: string[]): StubCoverage {
  const reflected = [
    ...Object.entries(data.classes).filter(([, c]) => c.castOnly !== true).map(([k]) => k),
    ...Object.keys(data.structs),
  ];
  const castOnly = Object.entries(data.classes).filter(([, c]) => c.castOnly === true).map(([k]) => k);
  const declared = new Set([...reflected, ...castOnly, ...opaque]);
  return { version: 1, reflected: [...new Set(reflected)].sort(), declared: [...declared].sort(), errors };
}

export function readCoverage(profileDir: string): StubCoverage | null {
  try {
    const parsed = JSON.parse(readFileSync(join(profileDir, COVERAGE_FILE), "utf8").replace(/^﻿/, "")) as StubCoverage;
    return parsed !== null && typeof parsed === "object" && parsed.version === 1 && Array.isArray(parsed.reflected) && Array.isArray(parsed.declared) ? parsed : null;
  } catch {
    return null;
  }
}

export interface StubSet {
  /** Relative path (with `/`) -> text of every declaration file. */
  files: Map<string, string>;
  index: unknown;
  lock: StubsLock;
  coverage: StubCoverage;
  cache: StubCache;
  library: unknown;
  /** The completion names of the catalog; null removes the file. */
  names: unknown | null;
  /** Delete `retired.json` (the run read the mod assets again). */
  clearRetired: boolean;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

function readIfExists(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function listFiles(root: string, rel: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) listFiles(root, r, out);
    else out.push(r);
  }
}

function removeEmptyDirs(root: string, rel: string): boolean {
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    if (e.isDirectory() && removeEmptyDirs(root, `${rel}/${e.name}`)) continue;
    empty = false;
  }
  if (empty) {
    try {
      rmdirSync(join(root, rel));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Writes the stub set file by file: `stubs.lock.json` is deleted first and written last (a crash leaves "no lock", which the next
 * build repairs), unchanged files are not touched, stale declaration files are pruned. There is no directory swap: Windows refuses to
 * rename a folder tsserver watches. `retired.json`, `gameplay-tags.json` and `_catalog.json` are never pruned.
 */
export function writeStubSet(profileDir: string, set: StubSet): { written: number; unchanged: number; removed: number } {
  mkdirSync(profileDir, { recursive: true });
  rmSync(join(profileDir, LOCK_FILE), { force: true });
  let written = 0;
  let unchanged = 0;
  let removed = 0;
  for (const [rel, text] of set.files) {
    const target = join(profileDir, ...rel.split("/"));
    if (readIfExists(target) === text) {
      unchanged++;
      continue;
    }
    writeFileAtomic(target, text);
    written++;
  }
  const existing: string[] = [];
  for (const top of ["Game", "Script", "Mod"]) listFiles(profileDir, top, existing);
  for (const rel of existing) {
    if (set.files.has(rel)) continue;
    rmSync(join(profileDir, ...rel.split("/")), { force: true });
    removed++;
  }
  for (const top of ["Game", "Script", "Mod"]) {
    if (existsSync(join(profileDir, top))) removeEmptyDirs(profileDir, top);
  }
  if (set.clearRetired) rmSync(join(profileDir, RETIRED_FILE), { force: true });
  writeFileAtomic(join(profileDir, INDEX_FILE), json(set.index));
  writeFileAtomic(join(profileDir, COVERAGE_FILE), json(set.coverage));
  writeFileAtomic(join(profileDir, CACHE_FILE), gzipSync(Buffer.from(JSON.stringify(set.cache), "utf8")));
  writeFileAtomic(join(profileDir, LIBRARY_FILE), JSON.stringify(set.library));
  if (set.names === null) rmSync(join(profileDir, NAMES_FILE), { force: true });
  else writeFileAtomic(join(profileDir, NAMES_FILE), JSON.stringify(set.names));
  writeLock(profileDir, set.lock);
  return { written, unchanged, removed };
}
