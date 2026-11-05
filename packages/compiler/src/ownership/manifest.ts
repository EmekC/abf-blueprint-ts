// Hash manifest (design 8.3): `.abfc/manifest/<asset>.json`, committed with the project.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ManifestUnit {
  /** "event:UpdateTarget" */
  id: string;
  graph: string;
  irHash: string;
  /** `unitStateHash` of `nodes` after the last apply; null until the unit was applied. */
  assetHash: string | null;
  /** Real node names of the unit. */
  nodes: string[];
  /** IR node id -> real node name. */
  nodeIds: Record<string, string>;
  /** Real name of the ownership comment box. */
  tag: string | null;
  /** `StageStatus.syncedAt` of the stage the unit was last applied to. */
  stageSyncedAt: string | null;
  adopt: { entry: string; nodes: string[]; hash: string; recordedAt: string; stageSyncedAt: string | null } | null;
  /** Per-node state hashes (optional; used to count edits in ABFC5001). */
  nodeHashes?: Record<string, string>;
  /** Sorted link list of the unit (optional; used to count links added/removed in ABFC5001). */
  links?: string[];
}

export interface Manifest {
  asset: string;
  compiler: string;
  profile: string;
  units: ManifestUnit[];
  variables: Array<{ name: string; type: string; hash: string }>;
}

/** `/Mod/Dir/BP_X` -> `Mod__Dir__BP_X` */
export function assetFileStem(asset: string): string {
  return asset.slice(1).replaceAll("/", "__");
}

export function manifestPath(dir: string, asset: string): string {
  return join(dir, ".abfc", "manifest", `${assetFileStem(asset)}.json`);
}

/** The manifest of an asset, or null when there is none. */
export function readManifest(dir: string, asset: string): Manifest | null {
  const file = manifestPath(dir, asset);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Manifest;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** Pretty JSON with sorted keys and a trailing newline. */
export function stringifySorted(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2) + "\n";
}

/** Writes the manifest and returns its file path. */
export function writeManifest(dir: string, m: Manifest): string {
  const file = manifestPath(dir, m.asset);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifySorted(m), "utf8");
  return file;
}

/** Owned unit names and variable names per asset, for stub generation. */
export function ownedSets(dir: string): Record<string, { units: string[]; variables: string[] }> {
  const folder = join(dir, ".abfc", "manifest");
  const out: Record<string, { units: string[]; variables: string[] }> = {};
  if (!existsSync(folder)) return out;
  for (const f of readdirSync(folder).filter((x) => x.endsWith(".json")).sort()) {
    const m = JSON.parse(readFileSync(join(folder, f), "utf8").replace(/^﻿/, "")) as Manifest;
    out[m.asset] = {
      units: m.units.map((u) => u.id.slice(u.id.indexOf(":") + 1)),
      variables: m.variables.map((v) => v.name),
    };
  }
  return out;
}
