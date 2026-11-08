import ts from "typescript";
import type { LoadedProgram } from "./program.js";
import { bpTagsOfSymbol, resolveAlias } from "./tags.js";

/** An engine class or struct the stubs hold only as an `@bpOpaque` placeholder (no members yet). */
export interface PlaceholderType {
  /** `@bpPath` of the placeholder, e.g. `/Script/UMG.TextBlock`. */
  path: string;
  /** Symbol name, e.g. `TextBlock`. */
  name: string;
}

const cache = new WeakMap<ts.Symbol, PlaceholderType | null>();

/** The placeholder a symbol declares (aliases are followed), or undefined when it is not an `@bpOpaque` class/struct. */
export function placeholderOfSymbol(checker: ts.TypeChecker, sym: ts.Symbol): PlaceholderType | undefined {
  let s = sym;
  try {
    s = resolveAlias(checker, sym);
  } catch {
    return undefined;
  }
  const hit = cache.get(s);
  if (hit !== undefined) return hit ?? undefined;
  const tags = bpTagsOfSymbol(s);
  const path = tags.get("bpPath")?.[0];
  const result: PlaceholderType | null = tags.has("bpOpaque") && path !== undefined && path !== "" && !path.includes(":") ? { path, name: s.name } : null;
  cache.set(s, result);
  return result ?? undefined;
}

/** Placeholders a type consists of (unions and intersections are split), deduplicated by path. */
export function placeholdersOfType(checker: ts.TypeChecker, type: ts.Type): PlaceholderType[] {
  const out = new Map<string, PlaceholderType>();
  const visit = (t: ts.Type): void => {
    if (t.isUnionOrIntersection()) {
      for (const m of t.types) visit(m);
      return;
    }
    const own = t.getSymbol();
    const viaOwn = own !== undefined ? placeholderOfSymbol(checker, own) : undefined;
    const alias = t.aliasSymbol;
    const found = viaOwn ?? (alias !== undefined ? placeholderOfSymbol(checker, alias) : undefined);
    if (found !== undefined && !out.has(found.path)) out.set(found.path, found);
  };
  visit(type);
  return [...out.values()];
}

/**
 * Paths of the placeholder classes and structs the class and test sources use: the receiver of a property or element
 * access has a placeholder type, or an identifier (outside import and export declarations) refers to a placeholder.
 */
export function placeholderTypesUsed(loaded: LoadedProgram): string[] {
  const checker = loaded.checker;
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      for (const p of placeholdersOfType(checker, checker.getTypeAtLocation(node.expression))) found.add(p.path);
    } else if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym !== undefined) {
        const p = placeholderOfSymbol(checker, sym);
        if (p !== undefined) found.add(p.path);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sf of [...loaded.files.classes, ...loaded.files.tests]) visit(sf);
  return [...found].sort();
}

/** The placeholder type of the receiver of the property access whose member name overlaps `[start, end)` in `sf`. */
export function placeholderReceiverAt(checker: ts.TypeChecker, sf: ts.SourceFile, start: number, end: number): PlaceholderType | undefined {
  let best: ts.PropertyAccessExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getEnd() < start || node.getStart(sf) > end) return;
    if (ts.isPropertyAccessExpression(node) && node.name.getStart(sf) <= end && node.name.getEnd() >= start) best = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (best === undefined) return undefined;
  return placeholdersOfType(checker, checker.getTypeAtLocation(best.expression))[0];
}
