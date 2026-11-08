import { win32 } from "node:path";
import type { Host } from "./discover.js";

/** One mod found in the mods folder (docs/design.md 18.5 item 5). */
export interface ModEntry {
  /** Folder name, which is also the `.uplugin` base name. */
  name: string;
  dir: string;
  /** `FriendlyName` of the `.uplugin`, or null when the file does not read as JSON or has none. */
  friendlyName: string | null;
  /** Number of `.uasset` files under `Content`, at most {@link MOD_SCAN_ASSET_CAP}. */
  assetCount: number;
  /** True when the walk stopped at the cap (there are more assets than `assetCount`). */
  assetCountCapped: boolean;
}

/** The asset walk stops after this many `.uasset` files. */
export const MOD_SCAN_ASSET_CAP = 5000;

function friendlyNameOf(host: Host, upluginPath: string): string | null {
  try {
    const j = JSON.parse(host.readFile(upluginPath).replace(/^﻿/, "")) as unknown;
    if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
    const f = (j as Record<string, unknown>).FriendlyName;
    return typeof f === "string" && f !== "" ? f : null;
  } catch {
    return null;
  }
}

function countAssets(host: Host, contentDir: string): { count: number; capped: boolean } {
  let count = 0;
  const pending = [contentDir];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of host.readDir(dir)) {
      if (entry.toLowerCase().endsWith(".uasset")) {
        count++;
        if (count > MOD_SCAN_ASSET_CAP) return { count: MOD_SCAN_ASSET_CAP, capped: true };
      } else {
        // Files have no children; readDir gives [] for them.
        pending.push(win32.join(dir, entry));
      }
    }
  }
  return { count, capped: false };
}

/**
 * Every direct subfolder `X` of `modsDir` that holds `X\X.uplugin` (name compared case-insensitively) is a mod.
 * Other folders are skipped silently. Sorted by name, case-insensitively.
 */
export function scanMods(host: Host, modsDir: string): ModEntry[] {
  const mods: ModEntry[] = [];
  for (const name of host.readDir(modsDir)) {
    const dir = win32.join(modsDir, name);
    const children = host.readDir(dir);
    const uplugin = children.find((c) => c.toLowerCase() === `${name}.uplugin`.toLowerCase());
    if (uplugin === undefined) continue;
    const content = children.find((c) => c.toLowerCase() === "content");
    const counted = content === undefined ? { count: 0, capped: false } : countAssets(host, win32.join(dir, content));
    mods.push({
      name,
      dir,
      friendlyName: friendlyNameOf(host, win32.join(dir, uplugin)),
      assetCount: counted.count,
      assetCountCapped: counted.capped,
    });
  }
  return mods.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
