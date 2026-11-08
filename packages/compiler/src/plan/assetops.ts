// Asset operations the build performs on the stage before it plans units (docs/design.md 18.2): renames of moved or renamed classes,
// deletes of assets abfc created whose class left the TypeScript, and reparent/recreate when `extends` changed. This module only
// decides; the build runs the ops through the backend (`bp_asset_ops`) and records the outcome in the manifests.
import type { Diagnostic } from "@abfc/ir";
import type { HirClass, HirProgram, ParentFamily } from "../hir.js";
import type { Manifest } from "../ownership/manifest.js";
import { matchOrphans, movedDiagnostic } from "../ownership/moved.js";

/** One `bp_asset_ops` operation; structurally the same as the backend package's `AssetOp`. */
export type PlannedAssetOp =
  | { op: "rename"; from: string; to: string }
  | { op: "delete"; asset: string }
  | { op: "reparent"; asset: string; parent: string }
  | { op: "recreate"; asset: string };

/** What the backend can do (`capabilities.assetOps`): any of `rename`, `delete`, `reparent`, `recreate`; empty when absent. */
export interface AssetOpCaps { assetOps: readonly string[] }

export interface AssetOpsPlan {
  /** In execution order: renames, then deletes of class-manager rows, then deletes of assets. */
  ops: PlannedAssetOp[];
  renames: Array<{ from: string; to: string; class: string }>;
  /** Blueprint assets abfc created whose class is gone from the TypeScript (each becomes a tombstone manifest). */
  deletes: string[];
  /** Class-manager rows abfc wrote for the deleted assets (deleted together with them). */
  rowDeletes: Array<{ asset: string; row: string }>;
  diagnostics: Diagnostic[];
}

/**
 * Renames and deletes for the classes of `hir` against the recorded `manifests`.
 * - A class (derived or explicit `path:`) with no manifest of its own and exactly one earlier asset that looks like it (moved.ts rules)
 *   is renamed from that asset. Several candidates, or one earlier asset claimed by several classes, stay ABFC5012 (error).
 *   A `@struct` is never renamed (ABFC5012 error). Without the `rename` capability nothing is renamed and the diagnostics are today's
 *   ABFC5012 errors (derived paths only).
 * - A Blueprint manifest that no class resolves to, that no class claims as its earlier asset, and that has `created: true` is
 *   deleted (and the class-manager row it wrote, unless another class still uses that row). Everything else (hand-made or adopted
 *   assets, manifests written before `created` existed, structs) is left to the build's retire path (ABFC5010).
 */
export function planAssetOps(hir: HirProgram, manifests: readonly Manifest[], mod: string, caps: AssetOpCaps): AssetOpsPlan {
  const plan: AssetOpsPlan = { ops: [], renames: [], deletes: [], rowDeletes: [], diagnostics: [] };
  const canRename = caps.assetOps.includes("rename");
  const canDelete = caps.assetOps.includes("delete");
  const { orphans, matches } = matchOrphans(hir, manifests, mod, { explicit: true });
  const claimed = new Set<string>();
  const claims = new Map<string, number>();
  for (const m of matches) for (const o of m.matches) claims.set(o.asset.toLowerCase(), (claims.get(o.asset.toLowerCase()) ?? 0) + 1);
  for (const m of matches) {
    for (const o of m.matches) claimed.add(o.asset.toLowerCase());
    const derived = m.decl.pathDerived;
    if (m.isStruct || !canRename || m.matches.length > 1) {
      // The old behaviour: an error for derived paths (an explicit `path:` never raised it)
      if (derived) plan.diagnostics.push(movedDiagnostic(m, mod, "error"));
      continue;
    }
    const from = m.matches[0]!.asset;
    if ((claims.get(from.toLowerCase()) ?? 0) > 1) {
      plan.diagnostics.push({
        severity: "error",
        code: "ABFC5012",
        message: `${m.decl.name} could be the class built as ${from}, but another class claims it too (${m.decl.path}). abfc will not guess which one to rename.`,
        span: m.decl.span,
        fix: "keep one of them with path: \"<its path below the mod>\"",
      });
      continue;
    }
    plan.renames.push({ from, to: m.decl.path, class: m.decl.name });
    plan.ops.push({ op: "rename", from, to: m.decl.path });
  }
  if (canDelete) {
    const wantedRows = new Set(hir.classes.flatMap((c) => (c.director !== undefined ? [c.director.asset.toLowerCase()] : [])));
    const rows: Array<{ asset: string; row: string }> = [];
    for (const m of orphans) {
      if (m.created !== true || m.structFieldsHash !== undefined || claimed.has(m.asset.toLowerCase())) continue;
      plan.deletes.push(m.asset);
      if (m.directorRow !== undefined && !wantedRows.has(m.directorRow.toLowerCase()) && !rows.some((r) => r.row.toLowerCase() === m.directorRow!.toLowerCase())) {
        rows.push({ asset: m.asset, row: m.directorRow });
      }
    }
    plan.rowDeletes.push(...rows);
    for (const r of rows) plan.ops.push({ op: "delete", asset: r.row });
    for (const a of plan.deletes) plan.ops.push({ op: "delete", asset: a });
  }
  return plan;
}

export interface ParentPlan {
  /** `none`: unchanged or unknown; `reparent`/`recreate`: run `ops`; `error`: ABFC2048 in `diagnostics`. */
  action: "none" | "reparent" | "recreate" | "error";
  ops: PlannedAssetOp[];
  diagnostics: Diagnostic[];
  from?: string;
  to?: string;
}

/** Class paths compare case-insensitively (the stage and the stubs may differ in case). */
export const sameClassPath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * What a changed `extends` needs. `manifest.parent` is the parent the asset was last built with; for manifests written before it
 * existed, `snapshotParent` (`parseExport().parentClass` of the read) is used. A parent in the family the asset was built with
 * (`manifest.parentFamily`; unknown counts as the same family) is a `reparent`, another family a `recreate` (the asset is deleted from
 * the stage and created again by the apply). `o.crossFamily` forces the recreate path: the caller sets it when the backend refused a
 * reparent for a family reason. A recreate of an asset abfc did not create (`manifest.created !== true`) is refused (ABFC2048): it
 * would delete hand-made content. Without the needed capability the answer is ABFC2048 too.
 */
export function parentOps(
  asset: string,
  manifest: Manifest | null,
  snapshotParent: string | null | undefined,
  cls: Pick<HirClass, "name" | "parent" | "family" | "span">,
  caps: AssetOpCaps,
  o: { crossFamily?: boolean } = {},
): ParentPlan {
  const from = manifest?.parent ?? snapshotParent ?? null;
  const to = cls.parent;
  if (from === null || sameClassPath(from, to)) return { action: "none", ops: [], diagnostics: [] };
  const oldFamily: ParentFamily | undefined = manifest?.parentFamily;
  const cross = o.crossFamily === true || (oldFamily !== undefined && oldFamily !== cls.family);
  const refuse = (why: string, fix: string): ParentPlan => ({
    action: "error",
    ops: [],
    diagnostics: [{ severity: "error", code: "ABFC2048", asset, span: cls.span, message: `${cls.name} extends ${to} now, but its asset was built with ${from}: ${why}`, fix }],
    from,
    to,
  });
  if (!cross) {
    if (!caps.assetOps.includes("reparent")) {
      return refuse("this backend cannot change the parent of an existing asset.", "update abf-mod-editor-mcp to 2.6.0, or restore the old extends clause.");
    }
    return { action: "reparent", ops: [{ op: "reparent", asset, parent: to }], diagnostics: [], from, to };
  }
  if (manifest?.created !== true) {
    return refuse(
      `the parent is in another family and the asset was not created by abfc, so recreating it would delete hand-made content.`,
      "restore the old extends clause, or delete the asset in the Mod Editor and build again.",
    );
  }
  if (!caps.assetOps.includes("recreate")) {
    return refuse("the parent is in another family, which needs the asset to be created again, and this backend cannot do that.", "update abf-mod-editor-mcp to 2.6.0, or restore the old extends clause.");
  }
  return { action: "recreate", ops: [{ op: "recreate", asset }], diagnostics: [], from, to };
}
