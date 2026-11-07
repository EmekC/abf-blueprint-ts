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

/** The name `idiv` is callable under (its local alias when imported as `idiv as x`) and the edit that makes it available, if any. */
function idivBinding(sf: ts.SourceFile): { name: string; edit?: TextEdit } {
  let appendAfter: ts.ImportSpecifier | undefined;
  let emptyBraces: ts.NamedImports | undefined;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== RUNTIME) continue;
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const named = clause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    const existing = named.elements.find((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === "idiv");
    if (existing !== undefined) return { name: existing.name.text };
    const last = named.elements[named.elements.length - 1];
    if (last !== undefined) appendAfter ??= last;
    else emptyBraces ??= named;
  }
  if (appendAfter !== undefined) return { name: "idiv", edit: { start: appendAfter.getEnd(), length: 0, newText: ", idiv" } };
  if (emptyBraces !== undefined) return { name: "idiv", edit: { start: emptyBraces.getStart(sf) + 1, length: 0, newText: " idiv " } };
  const first = sf.statements[0];
  return { name: "idiv", edit: { start: first === undefined ? 0 : first.getStart(sf), length: 0, newText: `import { idiv } from "${RUNTIME}";\n` } };
}

/** `a / b` -> `idiv(a, b)` (+ the import). Undefined when no division covers [start, end). */
export function idivFix(sf: ts.SourceFile, start: number, end: number): TextEdit[] | undefined {
  const div = innermostDivision(sf, start, end);
  if (div === undefined) return undefined;
  const binding = idivBinding(sf);
  const edits: TextEdit[] = [
    {
      start: div.getStart(sf),
      length: div.getEnd() - div.getStart(sf),
      newText: `${binding.name}(${div.left.getText(sf)}, ${div.right.getText(sf)})`,
    },
  ];
  if (binding.edit !== undefined) edits.push(binding.edit);
  return edits;
}

/** True when `n` is (part of) the target of an assignment, `++`/`--` or a `for ... of/in` head, where `?.` is not allowed. */
function isWriteTarget(n: ts.Node): boolean {
  let cur = n;
  for (let p = cur.parent as ts.Node | undefined; p !== undefined; cur = p, p = p.parent as ts.Node | undefined) {
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isObjectLiteralExpression(p) ||
      (ts.isPropertyAssignment(p) && p.initializer === cur)
    ) {
      continue; // possibly inside a destructuring pattern
    }
    if (ts.isBinaryExpression(p)) {
      return p.left === cur && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
    }
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
    }
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) return p.initializer === cur;
    return false;
  }
  return false;
}

/** The outermost member access / non-null / parenthesis chain that `n` is the object of. */
function chainTop(n: ts.Node): ts.Node {
  let top = n;
  for (;;) {
    const p = top.parent as ts.Node | undefined;
    if (
      p !== undefined &&
      (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p)) &&
      p.expression === top
    ) {
      top = p;
    } else {
      return top;
    }
  }
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
      // `a?.b = x` is a TypeScript error (TS2779): no valid fix on a write target
      if (isWriteTarget(chainTop(parent))) return;
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
