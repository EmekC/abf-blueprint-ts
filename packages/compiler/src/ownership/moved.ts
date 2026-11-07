// Moved or renamed class files (docs/design.md 18.2): a class whose file now derives a path with no manifest, while an orphan
// manifest of the same class exists elsewhere in the mod, is ABFC5012. abfc neither creates a second asset nor retires the first.
import { toModRelative } from "@abfc/ir";
import type { Diagnostic } from "@abfc/ir";
import type { HirProgram } from "../hir.js";
import type { Manifest } from "./manifest.js";

const lastSegment = (asset: string): string => asset.slice(asset.lastIndexOf("/") + 1);

/** ABFC5012 for every class or struct with a derived path that has no manifest but whose earlier asset is still recorded. */
export function movedClassDiagnostics(hir: HirProgram, manifests: readonly Manifest[], mod: string): Diagnostic[] {
  const prefix = `/${mod}/`.toLowerCase();
  const known = new Set(manifests.map((m) => m.asset.toLowerCase()));
  const declared = [...hir.classes, ...hir.structs];
  const resolved = new Set(declared.map((c) => c.path.toLowerCase()));
  const orphans = manifests.filter((m) => m.asset.toLowerCase().startsWith(prefix) && !resolved.has(m.asset.toLowerCase()));
  const out: Diagnostic[] = [];
  if (orphans.length === 0) return out;
  for (const c of declared) {
    if (!c.pathDerived || known.has(c.path.toLowerCase())) continue;
    const matches = orphans.filter((m) =>
      m.source !== undefined ? m.source.class === c.name || m.source.file === c.span.file : lastSegment(m.asset) === c.name,
    );
    if (matches.length === 0) continue;
    const tail = "abfc will not create a second asset or retire the first one.";
    if (matches.length === 1) {
      const m = matches[0]!;
      const rel = toModRelative(mod, m.asset) ?? m.asset;
      const from = m.source !== undefined ? ` (from ${m.source.file})` : "";
      out.push({
        severity: "error",
        code: "ABFC5012",
        message: `${c.name} was built as ${m.asset}${from} but its file now gives ${c.path}. ${tail}`,
        span: c.span,
        fix: `keep the asset where it is with path: "${rel}" (quick fix)`,
        data: { keepPath: rel, recorded: m.asset },
      });
    } else {
      out.push({
        severity: "error",
        code: "ABFC5012",
        message: `${c.name} has several earlier assets (${matches.map((m) => m.asset).join(", ")}) and its file now gives ${c.path}. ${tail}`,
        span: c.span,
        fix: "keep one of them with path: \"<its path below the mod>\"",
      });
    }
  }
  return out;
}
