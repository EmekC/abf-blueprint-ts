// Hover helpers for the language server: the stub description and TypeScript's symbol and type at a position.
import { resolve } from "node:path";
import ts from "typescript";
import type { LoadedProgram } from "./program.js";

const fwd = (p: string): string => p.replaceAll("\\", "/").toLowerCase();

/** The innermost identifier whose text range contains `pos`. */
function identifierAt(sf: ts.SourceFile, pos: number): ts.Identifier | ts.PrivateIdentifier | undefined {
  let found: ts.Identifier | ts.PrivateIdentifier | undefined;
  const visit = (node: ts.Node): void => {
    if (pos < node.getFullStart() || pos >= node.getEnd()) return;
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && pos >= node.getStart(sf) && pos < node.getEnd()) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The symbol of the identifier at `pos`, through an import alias. */
function symbolAt(loaded: LoadedProgram, sf: ts.SourceFile, pos: number): { symbol: ts.Symbol; id: ts.Identifier | ts.PrivateIdentifier } | undefined {
  const id = identifierAt(sf, pos);
  if (id === undefined) return undefined;
  let symbol = loaded.checker.getSymbolAtLocation(id);
  if (symbol === undefined) return undefined;
  if (symbol.flags & ts.SymbolFlags.Alias) symbol = loaded.checker.getAliasedSymbol(symbol);
  return { symbol, id };
}

/** The symbol and first declaration at `pos` when the declaration is under `<project>/.abfc/stubs/`; undefined elsewhere. */
function stubSymbolAt(loaded: LoadedProgram, sf: ts.SourceFile, pos: number): { symbol: ts.Symbol; decl: ts.Declaration } | undefined {
  const at = symbolAt(loaded, sf, pos);
  const decl = at?.symbol.declarations?.[0];
  if (at === undefined || decl === undefined) return undefined;
  const stubsRoot = fwd(resolve(loaded.projectDir, ".abfc", "stubs")) + "/";
  if (!fwd(resolve(decl.getSourceFile().fileName)).startsWith(stubsRoot)) return undefined;
  return { symbol: at.symbol, decl };
}

/** First line of the description of a stub symbol (a declaration under `<project>/.abfc/stubs/`) at `pos`; undefined elsewhere. */
export function stubDescriptionAt(loaded: LoadedProgram, sf: ts.SourceFile, pos: number): string | undefined {
  const at = stubSymbolAt(loaded, sf, pos);
  if (at === undefined) return undefined;
  const doc = ts.displayPartsToString(at.symbol.getDocumentationComment(loaded.checker));
  for (const line of doc.split(/\r?\n/)) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return undefined;
}

/** The `@bpPath` of the stub function or method at `pos` (for example `/Script/Engine.KismetSystemLibrary:PrintString`); undefined for other stub symbols (classes, properties) and non-stub symbols. */
export function stubBpPathAt(loaded: LoadedProgram, sf: ts.SourceFile, pos: number): string | undefined {
  const at = stubSymbolAt(loaded, sf, pos);
  if (at === undefined) return undefined;
  if (!ts.isFunctionDeclaration(at.decl) && !ts.isMethodDeclaration(at.decl) && !ts.isMethodSignature(at.decl)) return undefined;
  for (const tag of ts.getJSDocTags(at.decl)) {
    if (tag.tagName.text !== "bpPath") continue;
    const text = ts.getTextOfJSDocComment(tag.comment)?.trim();
    return text === undefined || text === "" ? undefined : text;
  }
  return undefined;
}

/** `name: type` of the symbol at `pos` (any file); undefined when there is no symbol there. */
export function tsQuickInfoAt(loaded: LoadedProgram, sf: ts.SourceFile, pos: number): string | undefined {
  const at = symbolAt(loaded, sf, pos);
  if (at === undefined) return undefined;
  const { checker } = loaded;
  return `${checker.symbolToString(at.symbol)}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(at.symbol, at.id))}`;
}
