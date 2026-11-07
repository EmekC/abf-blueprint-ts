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

/**
 * Hash of the editor and generator identity in the stub lock. The class lists are not part of it: what a unit uses from the stubs
 * (member references, pin names and types) is in its IR hash, so adding classes or assets to the stubs must not re-plan every unit.
 */
export function stubLockHashOf(lock: StubsLock | null): string {
  if (lock === null) return "no-lock";
  const { generator, profile, engineVersion, modEditorVersion, editorFingerprint, filterContentVersion } = lock;
  return sha256(JSON.stringify({ generator, profile, engineVersion, modEditorVersion, editorFingerprint, filterContentVersion }));
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

/** Forgets the cached units of one asset (it is no longer owned by abfc). */
export function dropUnitCacheAsset(file: string, asset: string): void {
  const cache = readUnitCache(file);
  if (!(asset in cache)) return;
  delete cache[asset];
  writeUnitCache(file, cache);
}
