// Imports of generated stubs (`/Script/...`, `/Game/...`) in the project source: which engine and game names the source asks for,
// so that `abfc generate` can generate exactly those, and which names a diagnostic range of an unresolved import points at.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export interface StubImport {
  /** The module specifier, e.g. `/Script/Engine` or `/Game/Fake/BP_Fake`. */
  specifier: string;
  /** The imported names (the exported name when aliased: `{ Actor as A }` -> `Actor`); empty for default and namespace imports. */
  names: string[];
  /** The source file the import is in. */
  file: string;
}

const isStubSpecifier = (s: string): boolean => s.startsWith("/Script/") || s.startsWith("/Game/");

function* sourceFiles(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(full);
    else if (e.isFile() && /\.tsx?$/i.test(e.name) && !/\.d\.ts$/i.test(e.name)) yield full;
  }
}

/** The named elements of an import or export declaration (type-only ones included). */
function elementsOf(decl: ts.ImportDeclaration | ts.ExportDeclaration): ReadonlyArray<ts.ImportSpecifier | ts.ExportSpecifier> {
  if (ts.isImportDeclaration(decl)) {
    const named = decl.importClause?.namedBindings;
    return named !== undefined && ts.isNamedImports(named) ? named.elements : [];
  }
  return decl.exportClause !== undefined && ts.isNamedExports(decl.exportClause) ? decl.exportClause.elements : [];
}

const nameOf = (el: ts.ImportSpecifier | ts.ExportSpecifier): string => (el.propertyName ?? el.name).text;

function stubSpecifierOf(node: ts.Node): { decl: ts.ImportDeclaration | ts.ExportDeclaration; specifier: ts.StringLiteral } | undefined {
  if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) return undefined;
  const spec = node.moduleSpecifier;
  if (spec === undefined || !ts.isStringLiteral(spec) || !isStubSpecifier(spec.text)) return undefined;
  return { decl: node, specifier: spec };
}

/**
 * Every import and re-export of a `/Script/...` or `/Game/...` module in the `.ts`/`.tsx` files (declaration files left out) under
 * `<projectDir>/<sourceRoot>`. A missing source root gives none.
 */
export function sourceStubImports(projectDir: string, sourceRoot: string): StubImport[] {
  const out: StubImport[] = [];
  for (const file of sourceFiles(join(projectDir, sourceRoot))) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("/Script/") && !text.includes("/Game/")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    for (const st of sf.statements) {
      const found = stubSpecifierOf(st);
      if (found === undefined) continue;
      out.push({ specifier: found.specifier.text, names: elementsOf(found.decl).map(nameOf), file });
    }
  }
  return out;
}

/**
 * The import or export declaration of a stub module that contains `[start, end)`: its specifier and the names the range touches
 * (the elements overlapping it, or every named element when the range is on the specifier or on no element).
 */
export function stubImportAt(sf: ts.SourceFile, start: number, end: number): { specifier: string; names: string[] } | undefined {
  for (const st of sf.statements) {
    const found = stubSpecifierOf(st);
    if (found === undefined) continue;
    if (start < st.getStart(sf) || end > st.getEnd()) continue;
    const elements = elementsOf(found.decl);
    const touched = elements.filter((el) => el.getStart(sf) < Math.max(end, start + 1) && start < el.getEnd());
    const picked = touched.length > 0 ? touched : elements;
    return { specifier: found.specifier.text, names: picked.map(nameOf) };
  }
  return undefined;
}
