import ts from "typescript";
import type { Diagnostic } from "@abfc/ir";
import { spanOf } from "./diag.js";
import type { LoadedProgram } from "./program.js";

/** Text stubgen puts into the `@deprecated` tag of a member the Blueprint filter blocks (and the profile does not override). */
const BLOCKED_MARK = "Blocked by Blueprint filter";

/**
 * ABFC7011: every use, in the class and test sources, of a stub member tagged `@deprecated Blocked by Blueprint filter`.
 * Members the profile overrides are not tagged by stubgen, so each hit here is outside `filterOverrides`. The upload
 * Asset Audit of the editor would reject such a node, so `abfc publish` refuses it.
 */
export function blockedMemberHits(loaded: LoadedProgram): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const hit = blockedText(loaded.checker, node);
      if (hit !== null) {
        const span = spanOf(node, loaded.projectDir);
        const k = `${span.file}:${span.line}:${span.col}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({
            severity: "error",
            code: "ABFC7011",
            message: `\`${node.text}\` is blocked by the Blueprint filter (${hit}); the upload Asset Audit rejects it.`,
            span,
            fix: "use another member, or add a filterOverrides entry to the profile when the audit is known to accept it.",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sf of [...loaded.files.classes, ...loaded.files.tests]) visit(sf);
  return out;
}

function blockedText(checker: ts.TypeChecker, id: ts.Identifier): string | null {
  let sym = checker.getSymbolAtLocation(id);
  if (sym === undefined) return null;
  if ((sym.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      return null;
    }
  }
  for (const tag of sym.getJsDocTags(checker)) {
    if (tag.name !== "deprecated") continue;
    const text = (tag.text ?? []).map((p) => p.text).join("");
    if (text.includes(BLOCKED_MARK)) return text.trim();
  }
  return null;
}
