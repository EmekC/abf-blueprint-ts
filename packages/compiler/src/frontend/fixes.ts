// Pure text edits behind the editor quick fixes (no language service types, so they test against plain source files).
import ts from "typescript";

export interface TextEdit {
  start: number;
  length: number;
  newText: string;
}

const RUNTIME = "@abfc/runtime";

/** The innermost `a / b` that covers [start, end). */
function innermostDivision(sf: ts.SourceFile, start: number, end: number): ts.BinaryExpression | undefined {
  let found: ts.BinaryExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sf) > start || node.getEnd() < end) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.SlashToken) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The edit that makes `idiv` available: nothing when it is already imported from `@abfc/runtime`. */
function idivImportEdit(sf: ts.SourceFile): TextEdit | undefined {
  let appendAfter: ts.ImportSpecifier | undefined;
  let emptyBraces: ts.NamedImports | undefined;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== RUNTIME) continue;
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const named = clause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    if (named.elements.some((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === "idiv")) return undefined;
    const last = named.elements[named.elements.length - 1];
    if (last !== undefined) appendAfter ??= last;
    else emptyBraces ??= named;
  }
  if (appendAfter !== undefined) return { start: appendAfter.getEnd(), length: 0, newText: ", idiv" };
  if (emptyBraces !== undefined) return { start: emptyBraces.getStart(sf) + 1, length: 0, newText: " idiv " };
  const first = sf.statements[0];
  return { start: first === undefined ? 0 : first.getStart(sf), length: 0, newText: `import { idiv } from "${RUNTIME}";\n` };
}

/** `a / b` -> `idiv(a, b)` (+ the import). Undefined when no division covers [start, end). */
export function idivFix(sf: ts.SourceFile, start: number, end: number): TextEdit[] | undefined {
  const div = innermostDivision(sf, start, end);
  if (div === undefined) return undefined;
  const edits: TextEdit[] = [
    {
      start: div.getStart(sf),
      length: div.getEnd() - div.getStart(sf),
      newText: `idiv(${div.left.getText(sf)}, ${div.right.getText(sf)})`,
    },
  ];
  const imp = idivImportEdit(sf);
  if (imp !== undefined) edits.push(imp);
  return edits;
}

/** `a.b` -> `a?.b` and `a[i]` -> `a?.[i]` where the node exactly spanning [start, end) is the `a`. */
export function optionalChainFix(sf: ts.SourceFile, start: number, end: number): TextEdit[] | undefined {
  let edit: TextEdit | undefined;
  const visit = (node: ts.Node): void => {
    if (edit !== undefined || node.getStart(sf) > start || node.getEnd() < end) return;
    const parent = node.parent as ts.Node | undefined;
    if (
      node.getStart(sf) === start &&
      node.getEnd() === end &&
      parent !== undefined &&
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === node &&
      parent.questionDotToken === undefined
    ) {
      if (ts.isPropertyAccessExpression(parent)) {
        // the `?` goes right before the dot, which may sit on the next line
        const dot = parent.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.DotToken);
        edit = { start: dot === undefined ? end : dot.getStart(sf), length: 0, newText: "?" };
      } else {
        edit = { start: end, length: 0, newText: "?." };
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edit === undefined ? undefined : [edit];
}
