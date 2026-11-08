// The build's asset operations on the stage (docs/design.md 18.2): renames of moved classes, deletes of assets abfc created whose
// class left the TypeScript, and reparent/recreate of an asset whose `extends` changed. plan/assetops.ts decides; this module runs
// the ops through the backend (`bp_asset_ops`) and keeps the manifests, source maps and unit cache in line with the stage.
import { win32 } from "node:path";
import type { AssetOp, AssetOpsResult, Backend } from "@abfc/backend";
import { deleteManifest, deleteSourceMap, parentOps, readManifest, readSourceMap, writeManifest, writeSourceMap } from "@abfc/compiler";
import type { AssetOpsPlan, HirClass, Manifest, ParentPlan } from "@abfc/compiler";
import type { Diagnostic } from "@abfc/ir";
import type { CliContext } from "../context.js";
import { dropUnitCacheAsset } from "../unitcache.js";
import { COMPILER_ID, missingInStage } from "./common.js";

const lower = (s: string): string => s.toLowerCase();

/** What the ops did, for the build's output. */
export interface AssetOpsOutcome {
  ok: boolean;
  renamed: Array<{ from: string; to: string }>;
  deleted: string[];
  /** Assets the ops edited on the stage besides the ones renamed/deleted (referencers whose nodes the rename fixed up) and the renamed assets themselves. */
  edited?: string[];
}

function describeOp(op: AssetOp): string {
  switch (op.op) {
    case "rename":
      return `rename ${op.from} to ${op.to}`;
    case "delete":
      return `delete ${op.asset}`;
    case "reparent":
      return `reparent ${op.asset} to ${op.parent}`;
    default:
      return `recreate ${op.asset}`;
  }
}

/** `backend.assetOps` that turns a thrown error into a failed result. */
async function callAssetOps(backend: Backend, mod: string, ops: AssetOp[]): Promise<AssetOpsResult> {
  try {
    return await backend.assetOps(mod, ops);
  } catch (e) {
    return { ok: false, results: [], touched: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** ABFC5016 for a failed `bp_asset_ops` call (the backend restored the stage). */
function failedOps(ops: AssetOp[], r: AssetOpsResult): Diagnostic {
  const failing = r.results.filter((x) => !x.ok).map((x) => x.detail).filter((d): d is string => d !== undefined && d !== "");
  const why = [r.error ?? "the backend reported no reason", ...failing.filter((d) => r.error === null || !r.error.includes(d))].join("; ");
  return {
    severity: "error",
    code: "ABFC5016",
    ...(ops[0] !== undefined ? { asset: "asset" in ops[0] ? ops[0].asset : ops[0].to } : {}),
    message: `the backend could not ${ops.map(describeOp).join(", ")}: ${why}. The stage was restored; nothing was changed.`,
    fix: "fix what the backend names (assets that still reference a deleted asset, an existing target), or keep a moved class where it was with path: \"<its path below the mod>\"; then run abfc build again.",
  };
}

/**
 * Runs the planned renames and deletes, plus the recoveries after a stage re-sync (a rename whose old asset is back on the stage and
 * a tombstone whose asset is back), then moves manifests, source maps and unit-cache entries. A failed call is ABFC5016 and nothing
 * on disk changes. `owned` are the assets this build publishes anyway; packages the rename fixup saved besides them are recorded in
 * the renamed manifest's `publishAlso`.
 */
export async function runAssetOps(
  ctx: CliContext,
  backend: Backend,
  o: {
    stagingPath: string;
    plan: AssetOpsPlan;
    classPaths: ReadonlySet<string>;
    owned: ReadonlySet<string>;
    manifests: readonly Manifest[];
    assetOps: readonly string[];
    /** The class-manager rows the IR's current `@director`s name (a row that went back to its old value is in use again). */
    directorRows?: readonly string[];
  },
): Promise<AssetOpsOutcome> {
  const { projectDir, paths, output } = ctx;
  const mod = ctx.config.mod.name;
  const cacheFile = win32.join(paths.cacheDir, "units.json");
  const classPaths = new Set([...o.classPaths].map(lower));
  const probe = [
    ...o.plan.renames.flatMap((r) => [r.from, r.to]),
    ...o.plan.deletes,
    ...o.plan.rowDeletes.map((r) => r.row),
    ...o.manifests.flatMap((m) => m.retiredRows ?? []),
    ...o.manifests.flatMap((m) => (m.renamedFrom !== undefined ? [m.renamedFrom, m.asset] : m.deleted === true ? [m.asset, ...(m.directorRow !== undefined ? [m.directorRow] : [])] : [])),
  ];
  const gone = missingInStage(ctx, o.stagingPath, probe);
  const exists = (asset: string): boolean => o.stagingPath === "" || !gone.has(asset);
  const can = (op: string): boolean => o.assetOps.includes(op);

  // Planned renames whose old asset the stage lacks (a re-sync lost a stage-only asset): nothing to rename, the class is created fresh.
  const renames = o.plan.renames.filter((r) => exists(r.from));
  const lostRenames = o.plan.renames.filter((r) => !exists(r.from));
  // A stage re-synced from the mod gives the old asset back: the rename is repeated.
  const repeated = o.manifests
    .filter((m) => m.renamedFrom !== undefined && m.deleted !== true && classPaths.has(lower(m.asset)) && can("rename") && exists(m.renamedFrom) && !exists(m.asset))
    .map((m) => ({ from: m.renamedFrom!, to: m.asset }));
  const deletes = o.plan.deletes.filter((a) => exists(a));
  const lostDeletes = o.plan.deletes.filter((a) => !exists(a));
  const rowDeletes = o.plan.rowDeletes.filter((r) => exists(r.row) && deletes.some((d) => lower(d) === lower(r.asset)));
  // A tombstone whose asset is back on the stage (re-sync before the publish that deletes it): deleted again.
  const repeatedDeletes = o.manifests.filter((m) => m.deleted === true && can("delete") && !classPaths.has(lower(m.asset)) && exists(m.asset));
  const repeatedRows = repeatedDeletes.flatMap((m) => (m.directorRow !== undefined && exists(m.directorRow) ? [m.directorRow] : []));
  // A row retired by a changed @director that is back on the stage (re-sync before the publish that deletes it): deleted again, unless a
  // class uses it (as its current row) or it is already deleted in this call.
  const inUse = new Set([
    ...o.manifests.filter((m) => m.deleted !== true && m.directorRow !== undefined).map((m) => lower(m.directorRow!)),
    ...(o.directorRows ?? []).map(lower),
  ]);
  const already = new Set([...rowDeletes.map((r) => r.row), ...repeatedRows].map(lower));
  const retiredAgain = [
    ...new Set(o.manifests.flatMap((m) => (can("delete") && m.deleted !== true ? (m.retiredRows ?? []).filter((row) => exists(row) && !inUse.has(lower(row)) && !already.has(lower(row))) : []))),
  ];

  const ops: AssetOp[] = [
    ...renames.map((r): AssetOp => ({ op: "rename", from: r.from, to: r.to })),
    ...repeated.map((r): AssetOp => ({ op: "rename", from: r.from, to: r.to })),
    ...[...rowDeletes.map((r) => r.row), ...repeatedRows, ...retiredAgain].map((row): AssetOp => ({ op: "delete", asset: row })),
    ...[...deletes, ...repeatedDeletes.map((m) => m.asset)].map((asset): AssetOp => ({ op: "delete", asset })),
  ];
  const outcome: AssetOpsOutcome = { ok: true, renamed: [], deleted: [] };
  let touched: string[] = [];
  if (ops.length > 0) {
    const r = await callAssetOps(backend, mod, ops);
    if (!r.ok) {
      output.diag(failedOps(ops, r));
      return { ...outcome, ok: false };
    }
    touched = r.touched;
  }
  const moved = new Set([...renames, ...repeated].flatMap((r) => [lower(r.from), lower(r.to)]));
  const also = touched.filter((t) => !moved.has(lower(t)) && !o.owned.has(t) && !classPaths.has(lower(t)));
  outcome.edited = [...new Set([...touched, ...renames.map((r) => r.to), ...repeated.map((r) => r.to)])];

  for (const r of renames) {
    const old = readManifest(projectDir, r.from);
    if (old !== null) {
      const renamedFrom = old.renamedFrom ?? r.from;
      const publishAlso = [...new Set([...(old.publishAlso ?? []), ...also])].sort();
      const { renamedFrom: _r, publishAlso: _p, asset: _a, ...rest } = old;
      writeManifest(projectDir, {
        ...rest,
        asset: r.to,
        ...(lower(renamedFrom) !== lower(r.to) ? { renamedFrom } : {}),
        ...(publishAlso.length > 0 ? { publishAlso } : {}),
      });
      deleteManifest(projectDir, r.from);
    }
    const sm = readSourceMap(projectDir, r.from);
    if (sm !== null) writeSourceMap(projectDir, { ...sm, asset: r.to });
    deleteSourceMap(projectDir, r.from);
    dropUnitCacheAsset(cacheFile, r.from);
    outcome.renamed.push({ from: r.from, to: r.to });
    output.info(`renamed ${r.from} -> ${r.to}`);
  }
  for (const r of repeated) {
    const m = readManifest(projectDir, r.to);
    if (m !== null && also.length > 0) writeManifest(projectDir, { ...m, publishAlso: [...new Set([...(m.publishAlso ?? []), ...also])].sort() });
    outcome.renamed.push(r);
    output.info(`renamed ${r.from} -> ${r.to} (again: the stage was re-synced before the rename was published)`);
  }
  for (const r of lostRenames) {
    // The earlier asset is not in the stage: forget it; the class gets a new asset.
    deleteManifest(projectDir, r.from);
    deleteSourceMap(projectDir, r.from);
    dropUnitCacheAsset(cacheFile, r.from);
    output.info(`forgot ${r.from}: it is not in the stage any more; ${r.class} gets a new asset at ${r.to}`);
  }
  for (const asset of deletes) {
    const m = readManifest(projectDir, asset);
    const row = rowDeletes.find((r) => lower(r.asset) === lower(asset))?.row;
    writeManifest(projectDir, {
      asset,
      deleted: true,
      units: [],
      variables: [],
      compiler: COMPILER_ID,
      profile: ctx.env.profile.id,
      ...(m?.source !== undefined ? { source: m.source } : {}),
      ...(row !== undefined ? { directorRow: row } : {}),
    });
    deleteSourceMap(projectDir, asset);
    dropUnitCacheAsset(cacheFile, asset);
    outcome.deleted.push(asset);
    output.info(`deleted ${asset}`);
  }
  for (const m of repeatedDeletes) {
    outcome.deleted.push(m.asset);
    output.info(`deleted ${m.asset} (again: the stage was re-synced before the delete was published)`);
  }
  for (const row of retiredAgain) output.info(`deleted ${row} (again: the stage was re-synced before the delete was published)`);
  for (const asset of lostDeletes) {
    deleteManifest(projectDir, asset);
    deleteSourceMap(projectDir, asset);
    dropUnitCacheAsset(cacheFile, asset);
    output.info(`forgot ${asset}: it is not in the stage and its class is gone`);
  }
  return outcome;
}

/**
 * Deletes class-manager rows on the stage (the row of a `@director` that changed or went away). True when the backend deleted all of
 * them; false (nothing changed: all-or-nothing) when it cannot or refused, so the caller falls back to the ABFC5013 warning.
 */
export async function deleteRetiredRows(ctx: CliContext, backend: Backend, assetOps: readonly string[], rows: readonly string[]): Promise<boolean> {
  if (rows.length === 0 || !assetOps.includes("delete")) return false;
  const r = await callAssetOps(backend, ctx.config.mod.name, rows.map((asset): AssetOp => ({ op: "delete", asset })));
  return r.ok;
}

export interface ParentOutcome {
  action: "none" | "reparent" | "recreate" | "error";
  /** Diagnostics to print (ABFC2048 or ABFC5016); an error stops the build. */
  diagnostics: Diagnostic[];
}

/**
 * A changed `extends` of one existing asset: reparent in the same family, recreate (delete from the stage, the apply creates it again)
 * in another. Without knowing the old family the backend decides: a reparent it refuses for a family reason is retried as a recreate.
 */
export async function runParentChange(
  ctx: CliContext,
  backend: Backend,
  o: { asset: string; manifest: Manifest | null; snapshotParent: string | null; cls: HirClass; assetOps: readonly string[] },
): Promise<ParentOutcome> {
  const mod = ctx.config.mod.name;
  const caps = { assetOps: o.assetOps };
  let plan: ParentPlan = parentOps(o.asset, o.manifest, o.snapshotParent, o.cls, caps);
  if (plan.action === "none" || plan.action === "error") return { action: plan.action, diagnostics: plan.diagnostics };
  let r = await callAssetOps(backend, mod, plan.ops as AssetOp[]);
  if (!r.ok && plan.action === "reparent" && /famil/i.test([r.error ?? "", ...r.results.map((x) => x.detail ?? "")].join(" "))) {
    plan = parentOps(o.asset, o.manifest, o.snapshotParent, o.cls, caps, { crossFamily: true });
    if (plan.action === "error") return { action: "error", diagnostics: plan.diagnostics };
    r = await callAssetOps(backend, mod, plan.ops as AssetOp[]);
  }
  if (!r.ok) return { action: "error", diagnostics: [failedOps(plan.ops as AssetOp[], r)] };
  ctx.output.info(plan.action === "reparent" ? `reparented ${o.asset}: ${plan.from} -> ${plan.to}` : `recreating ${o.asset}: ${plan.from} -> ${plan.to} is in another family, the asset is created again`);
  return { action: plan.action, diagnostics: [] };
}
