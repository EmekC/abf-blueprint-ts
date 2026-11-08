// Moved or renamed class files (docs/design.md 18.2): a class whose file now derives a path with no manifest, while an orphan
// manifest of the same class exists elsewhere in the mod. With one match (and a backend that can rename) the next build renames the
// asset on the stage; with several matches, a struct, or a backend without `rename` it is ABFC5012 and abfc neither creates a second
// asset nor retires the first. The matching (`matchOrphans`) is shared with the build's asset-ops planner (plan/assetops.ts).
import { toModRelative } from "@abfc/ir";
import type { Diagnostic } from "@abfc/ir";
import type { HirClass, HirProgram, HirStruct } from "../hir.js";
import type { Manifest } from "./manifest.js";

const lastSegment = (asset: string): string => asset.slice(asset.lastIndexOf("/") + 1);

/** One class or struct whose path has no manifest and the earlier assets that look like it. */
export interface OrphanMatch {
  decl: HirClass | HirStruct;
  isStruct: boolean;
  /** At least one; several = ambiguous. */
  matches: Manifest[];
}

/**
 * The earlier assets (manifests under the mod that no class or struct resolves to any more, tombstones excluded) that each declaration
 * without a manifest of its own looks like: the same class name first (several classes may share one file), the same file only when no
 * orphan carries the name (class renamed). `explicit` also considers classes with a `path:` option (the planner renames those too).
 */
export function matchOrphans(hir: HirProgram, manifests: readonly Manifest[], mod: string, o: { explicit?: boolean } = {}): { orphans: Manifest[]; matches: OrphanMatch[] } {
  const prefix = `/${mod}/`.toLowerCase();
  const known = new Set(manifests.map((m) => m.asset.toLowerCase()));
  const declared = [...hir.classes, ...hir.structs];
  const resolved = new Set(declared.map((c) => c.path.toLowerCase()));
  const orphans = manifests.filter((m) => m.deleted !== true && m.asset.toLowerCase().startsWith(prefix) && !resolved.has(m.asset.toLowerCase()));
  const matches: OrphanMatch[] = [];
  if (orphans.length === 0) return { orphans, matches };
  for (const c of declared) {
    if ((!c.pathDerived && o.explicit !== true) || known.has(c.path.toLowerCase())) continue;
    const isStruct = !("events" in c);
    // A mod-defined struct is never a match for a class, and a class manifest is never one for a struct.
    const candidates = orphans.filter((m) => (isStruct ? m.structFieldsHash !== undefined || m.units.length === 0 : m.structFieldsHash === undefined));
    const byName = candidates.filter((m) => (m.source !== undefined ? m.source.class === c.name : lastSegment(m.asset) === c.name));
    const found = byName.length > 0 ? byName : candidates.filter((m) => m.source !== undefined && m.source.file === c.span.file);
    if (found.length > 0) matches.push({ decl: c, isStruct, matches: found });
  }
  return { orphans, matches };
}

/**
 * ABFC5012 for one declaration. A single match of a class is a warning when `singleMatch` is "warning" (the next build renames the
 * asset), else an error; structs and several matches are always errors.
 */
export function movedDiagnostic(m: OrphanMatch, mod: string, singleMatch: "warning" | "error"): Diagnostic {
  const c = m.decl;
  const tail = "abfc will not create a second asset or retire the first one.";
  if (m.matches.length === 1) {
    const orphan = m.matches[0]!;
    const rel = toModRelative(mod, orphan.asset) ?? orphan.asset;
    const from = orphan.source !== undefined ? ` (from ${orphan.source.file})` : "";
    const rename = singleMatch === "warning" && !m.isStruct;
    return {
      severity: rename ? "warning" : "error",
      code: "ABFC5012",
      message: rename
        ? `${c.name} was built as ${orphan.asset}${from}; the next abfc build renames the asset to ${c.path} (backend 2.6.0).`
        : `${c.name} was built as ${orphan.asset}${from} but its file now gives ${c.path}. ${tail}`,
      span: c.span,
      fix: `keep the asset where it is with path: "${rel}" (quick fix)`,
      data: { keepPath: rel, recorded: orphan.asset },
    };
  }
  return {
    severity: "error",
    code: "ABFC5012",
    message: `${c.name} has several earlier assets (${m.matches.map((x) => x.asset).join(", ")}) and its file now gives ${c.path}. ${tail}`,
    span: c.span,
    fix: "keep one of them with path: \"<its path below the mod>\"",
  };
}

/**
 * ABFC5012 for every class or struct with a derived path that has no manifest but whose earlier asset is still recorded. `abfc check`
 * and the language service have no backend: a single match of a class is a warning there ("the next build renames it"). The build passes
 * `singleMatch: "error"` when the backend cannot rename.
 */
export function movedClassDiagnostics(hir: HirProgram, manifests: readonly Manifest[], mod: string, o: { singleMatch?: "warning" | "error" } = {}): Diagnostic[] {
  return matchOrphans(hir, manifests, mod).matches.map((m) => movedDiagnostic(m, mod, o.singleMatch ?? "warning"));
}
