import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AbfcError } from "./errors.js";
import { isSafeEntryName, readZip } from "./zip.js";

/** The runtime folder abfc.exe extracts from its SEA assets (design 18.8). */

export interface RuntimeManifest {
  schemaVersion: 1;
  abfcVersion: string;
  zipSha256: string;
  /** Forward-slash relative paths. */
  files: Record<string, { size: number; sha256: string }>;
}

export interface RuntimeSource {
  manifest(): RuntimeManifest;
  zip(): Buffer;
}

export const RUNTIME_MARKER = ".abfc-runtime.json";

export function runtimeFolderName(m: RuntimeManifest): string {
  return `${m.abfcVersion}-${m.zipSha256.slice(0, 8)}`;
}

function sha256Of(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function fileIn(dir: string, rel: string): string {
  return join(dir, ...rel.split("/"));
}

/** Problems found in an extracted runtime folder (empty = fine). Quick = marker + existence and size of every file; deep adds sha256. */
export function verifyRuntime(dir: string, m: RuntimeManifest, deep: boolean): string[] {
  const problems: string[] = [];
  try {
    const marker = JSON.parse(readFileSync(join(dir, RUNTIME_MARKER), "utf8")) as { abfcVersion?: unknown; zipSha256?: unknown };
    if (marker.zipSha256 !== m.zipSha256 || marker.abfcVersion !== m.abfcVersion) problems.push(`${RUNTIME_MARKER} does not match this abfc.exe`);
  } catch {
    problems.push(`${RUNTIME_MARKER} is missing or unreadable`);
  }
  for (const [rel, info] of Object.entries(m.files)) {
    const p = fileIn(dir, rel);
    let size: number;
    try {
      const st = statSync(p);
      if (!st.isFile()) {
        problems.push(`${rel} is not a file`);
        continue;
      }
      size = st.size;
    } catch {
      problems.push(`${rel} is missing`);
      continue;
    }
    if (size !== info.size) {
      problems.push(`${rel} has size ${size}, expected ${info.size}`);
      continue;
    }
    if (deep) {
      try {
        if (sha256Of(readFileSync(p)) !== info.sha256) problems.push(`${rel} has a different sha256`);
      } catch {
        problems.push(`${rel} cannot be read`);
      }
    }
  }
  return problems;
}

function renameWithRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (existsSync(to) || i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function rand(): string {
  return randomBytes(4).toString("hex");
}

function fail(code: string, message: string, tried: Array<{ source: string; detail: string }>, fix: string): AbfcError {
  return new AbfcError({ severity: "error", code, message, tried, fix });
}

const FIX_1050 =
  "check free disk space and antivirus quarantine, close other abfc processes, then run abfc doctor --deep; or set ABFC_RUNTIME_DIR to another folder";
const FIX_1051 = "close other abfc processes (language server, builds) and run abfc doctor --deep.";
const FIX_1052 = "abfc.exe is damaged; reinstall it (installer or zip).";

export function ensureRuntime(
  source: RuntimeSource,
  rootDir: string,
  opts?: { deep?: boolean },
): { dir: string; extracted: boolean; repaired: boolean } {
  const deep = opts?.deep === true;
  const m = source.manifest();
  const name = runtimeFolderName(m);
  const dir = join(rootDir, name);
  let repaired = false;
  if (existsSync(dir)) {
    const problems = verifyRuntime(dir, m, deep);
    if (problems.length === 0) return { dir, extracted: false, repaired: false };
    const bad = join(rootDir, `.bad-${name}-${process.pid}-${rand()}`);
    try {
      renameWithRetry(dir, bad);
    } catch (e) {
      throw fail(
        "ABFC1051",
        `the runtime folder ${dir} is damaged and cannot be replaced (${(e as Error).message})`,
        problems.slice(0, 10).map((p) => ({ source: "problem", detail: p })),
        FIX_1051,
      );
    }
    try {
      rmSync(bad, { recursive: true, force: true });
    } catch {
      // a leftover .bad-* folder is removed by abfc doctor --clean-runtimes
    }
    repaired = true;
  }

  const zipBuf = source.zip();
  if (sha256Of(zipBuf) !== m.zipSha256) throw fail("ABFC1052", "the runtime archive inside abfc.exe does not match its manifest", [], FIX_1052);

  try {
    mkdirSync(rootDir, { recursive: true });
  } catch (e) {
    throw fail("ABFC1050", `cannot create the runtime root ${rootDir}: ${(e as Error).message}`, [], FIX_1050);
  }
  const tmp = join(rootDir, `.tmp-${name}-${process.pid}-${rand()}`);
  try {
    const written = new Set<string>();
    for (const entry of readZip(zipBuf)) {
      const info = m.files[entry.name];
      if (!isSafeEntryName(entry.name) || info === undefined) {
        throw fail("ABFC1052", `the runtime archive holds an unexpected entry "${entry.name}"`, [], FIX_1052);
      }
      const data = entry.read();
      if (data.length !== info.size || sha256Of(data) !== info.sha256) {
        throw fail("ABFC1052", `the runtime archive entry "${entry.name}" does not match its manifest`, [], FIX_1052);
      }
      const target = fileIn(tmp, entry.name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      written.add(entry.name);
    }
    for (const rel of Object.keys(m.files)) {
      if (!written.has(rel)) throw fail("ABFC1052", `the runtime archive lacks "${rel}"`, [], FIX_1052);
    }
    writeFileSync(
      join(tmp, RUNTIME_MARKER),
      JSON.stringify({ abfcVersion: m.abfcVersion, zipSha256: m.zipSha256, files: written.size }) + "\n",
    );
  } catch (e) {
    rmQuiet(tmp);
    if (e instanceof AbfcError) throw e;
    throw fail("ABFC1050", `cannot extract the runtime to ${dir}: ${(e as Error).message}`, [], FIX_1050);
  }

  try {
    renameWithRetry(tmp, dir);
  } catch (e) {
    if (existsSync(dir) && verifyRuntime(dir, m, false).length === 0) {
      rmQuiet(tmp);
      return { dir, extracted: false, repaired };
    }
    rmQuiet(tmp);
    throw fail("ABFC1050", `cannot move the extracted runtime into ${dir}: ${(e as Error).message}`, [], FIX_1050);
  }
  return { dir, extracted: true, repaired };
}

function rmQuiet(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Removes every entry of `rootDir` except `keepName` (also `.tmp-*` and `.bad-*`). Failures are collected, never thrown. */
export function cleanRuntimes(rootDir: string, keepName: string | null): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(rootDir);
  } catch {
    return { removed, failed };
  }
  const keep = keepName === null ? null : keepName.toLowerCase();
  for (const n of names) {
    if (keep !== null && n.toLowerCase() === keep) continue;
    const p = join(rootDir, n);
    try {
      rmSync(p, { recursive: true, force: true });
      if (existsSync(p)) failed.push(p);
      else removed.push(p);
    } catch {
      failed.push(p);
    }
  }
  return { removed, failed };
}
