// .abfc/cache/units.json: what each unit was last built with, so a compiler or stub change re-plans units whose IR hash is equal.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "@abfc/ir";
import type { StubsLock } from "@abfc/stubgen";

export interface UnitCacheEntry {
  irHash: string;
  stubLockHash: string;
  compilerVersion: string;
}

/** `{[asset path]: {[unit id]: entry}}` */
export type UnitCache = Record<string, Record<string, UnitCacheEntry>>;

/** Hash of the stub lock without its timestamp (regenerating identical stubs does not invalidate the cache). */
export function stubLockHashOf(lock: StubsLock | null): string {
  if (lock === null) return "no-lock";
  const { createdAt: _createdAt, ...rest } = lock;
  return sha256(JSON.stringify(rest));
}

/** Reads the cache; a missing or damaged file is an empty cache. */
export function readUnitCache(file: string): UnitCache {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as UnitCache) : {};
  } catch {
    return {};
  }
}

export function writeUnitCache(file: string, cache: UnitCache): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2) + "\n", "utf8");
}
