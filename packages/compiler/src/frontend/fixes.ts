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

/** The name the `@abfc/runtime` export `exportName` is callable under (its local alias when imported as `x as y`) and the edit that makes it available, if any. */
function runtimeBinding(sf: ts.SourceFile, exportName: string): { name: string; edit?: TextEdit } {
  let appendAfter: ts.ImportSpecifier | undefined;
  let emptyBraces: ts.NamedImports | undefined;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== RUNTIME) continue;
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const named = clause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    const existing = named.elements.find((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === exportName);
    if (existing !== undefined) return { name: existing.name.text };
    const last = named.elements[named.elements.length - 1];
    if (last !== undefined) appendAfter ??= last;
    else emptyBraces ??= named;
  }
  if (appendAfter !== undefined) return { name: exportName, edit: { start: appendAfter.getEnd(), length: 0, newText: `, ${exportName}` } };
  if (emptyBraces !== undefined) return { name: exportName, edit: { start: emptyBraces.getStart(sf) + 1, length: 0, newText: ` ${exportName} ` } };
  const first = sf.statements[0];
  return { name: exportName, edit: { start: first === undefined ? 0 : first.getStart(sf), length: 0, newText: `import { ${exportName} } from "${RUNTIME}";\n` } };
}

/** `a / b` -> `idiv(a, b)` (+ the import). Undefined when no division covers [start, end). */
export function idivFix(sf: ts.SourceFile, start: number, end: number): TextEdit[] | undefined {
  const div = innermostDivision(sf, start, end);
  if (div === undefined) return undefined;
  const binding = runtimeBinding(sf, "idiv");
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

// ---- asset path and director fixes (docs/design.md 18.1 to 18.3) ----

type StringLit = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;

const isStringLit = (n: ts.Node): n is StringLit => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

/** `@blueprint(...)` / `@struct(...)` decorator calls of the file (callee matched by identifier text, like the frontend). */
function assetDecoratorCalls(sf: ts.SourceFile, names: readonly string[]): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      for (const d of ts.getDecorators(node) ?? []) {
        const e = d.expression;
        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && names.includes(e.expression.text)) out.push(e);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The option `key: "<literal>"` of a decorator call whose property contains [start, end) (or lies inside it). */
function optionAt(
  sf: ts.SourceFile,
  names: readonly string[],
  key: string,
  start: number,
  end: number,
): { call: ts.CallExpression; obj: ts.ObjectLiteralExpression; prop: ts.PropertyAssignment; lit: StringLit } | undefined {
  for (const call of assetDecoratorCalls(sf, names)) {
    const obj = call.arguments[0];
    if (obj === undefined || !ts.isObjectLiteralExpression(obj)) continue;
    for (const prop of obj.properties) {
      if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) || prop.name.text !== key) continue;
      if (!isStringLit(prop.initializer)) continue;
      const a = prop.getStart(sf);
      const b = prop.getEnd();
      if ((a <= start && end <= b) || (start <= a && b <= end)) return { call, obj, prop, lit: prop.initializer };
    }
  }
  return undefined;
}

/** Edits that remove the option `prop` of `obj`: with its neighbouring comma, or the whole object argument when it is the only one. */
function removeOptionEdits(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression, prop: ts.PropertyAssignment): TextEdit[] {
  const props = obj.properties;
  if (props.length === 1) return [{ start: obj.getStart(sf), length: obj.getEnd() - obj.getStart(sf), newText: "" }];
  const i = props.indexOf(prop);
  const next = props[i + 1];
  if (next !== undefined) return [{ start: prop.getStart(sf), length: next.getStart(sf) - prop.getStart(sf), newText: "" }];
  const prev = props[i - 1]!;
  return [{ start: prev.getEnd(), length: prop.getEnd() - prev.getEnd(), newText: "" }];
}

/** Removes the `path` option of a `@blueprint`/`@struct` call covering [start, end); the only option takes the whole `{ ... }` with it. */
export function removePathFix(sf: ts.SourceFile, start: number, end: number): TextEdit[] | undefined {
  const o = optionAt(sf, ["blueprint", "struct"], "path", start, end);
  return o === undefined ? undefined : removeOptionEdits(sf, o.obj, o.prop);
}

/** Rewrites the literal `<q>/<mod>/A/B<q>` as `<q>A/B<q>` (same quote character), a text edit at the literal. */
function literalEdit(sf: ts.SourceFile, lit: StringLit, newText: string): TextEdit {
  const q = sf.text[lit.getStart(sf)] ?? '"';
  return { start: lit.getStart(sf), length: lit.getEnd() - lit.getStart(sf), newText: `${q}${newText}${q}` };
}

/** `path: "/<mod>/A/B"` -> `path: "A/B"` for the path option covering [start, end). */
export function relativePathFix(sf: ts.SourceFile, start: number, end: number, mod: string): TextEdit[] | undefined {
  const o = optionAt(sf, ["blueprint", "struct"], "path", start, end);
  if (o === undefined) return undefined;
  const prefix = `/${mod}/`;
  if (!o.lit.text.toLowerCase().startsWith(prefix.toLowerCase()) || o.lit.text.length === prefix.length) return undefined;
  return [literalEdit(sf, o.lit, o.lit.text.slice(prefix.length))];
}

/** `import ... from "/<mod>/A"` -> `"@mod/A"` for the module specifier covering [start, end). */
export function modImportFix(sf: ts.SourceFile, start: number, end: number, mod: string): TextEdit[] | undefined {
  const prefix = `/${mod}/`;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier;
    const a = spec.getStart(sf);
    const b = spec.getEnd();
    if (!((a <= start && end <= b) || (start <= a && b <= end))) continue;
    if (!spec.text.toLowerCase().startsWith(prefix.toLowerCase()) || spec.text.length === prefix.length) return undefined;
    return [literalEdit(sf, spec, `@mod/${spec.text.slice(prefix.length)}`)];
  }
  return undefined;
}

/**
 * `@blueprint({ classManagerRow: "/<mod>/<table>/<Row>" })` -> `@director("<Row>") @blueprint()`: removes the option, puts the
 * director decorator on its own line above `@blueprint` (same indentation) and imports `director` from `@abfc/runtime`.
 */
export function directorFix(sf: ts.SourceFile, start: number, end: number, mod: string, table: string): TextEdit[] | undefined {
  const o = optionAt(sf, ["blueprint"], "classManagerRow", start, end);
  if (o === undefined) return undefined;
  const prefix = `/${mod}/${table}/`;
  const text = o.lit.text;
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return undefined;
  const row = text.slice(prefix.length);
  if (!/^[A-Za-z0-9_]+$/.test(row)) return undefined;
  const decorator = o.call.parent;
  if (!ts.isDecorator(decorator)) return undefined;
  const at = decorator.getStart(sf);
  const lineStart = sf.text.lastIndexOf("\n", at - 1) + 1;
  const before = sf.text.slice(lineStart, at);
  const indent = before.trim() === "" ? before : "";
  const binding = runtimeBinding(sf, "director");
  let insert: TextEdit = { start: at, length: 0, newText: `@${binding.name}(${JSON.stringify(row)})\n${indent}` };
  const edits: TextEdit[] = [...removeOptionEdits(sf, o.obj, o.prop)];
  if (binding.edit !== undefined) {
    if (binding.edit.start === at) insert = { start: at, length: 0, newText: binding.edit.newText + insert.newText };
    else edits.push(binding.edit);
  }
  edits.push(insert);
  return edits;
}

/**
 * Keeps an asset where it is: adds `path: "<relPath>"` as the first option of the `@blueprint`/`@struct` of the class whose name
 * starts at `classNameStart`. Undefined when the class has no such decorator or already has a `path` option.
 */
export function keepPathFix(sf: ts.SourceFile, classNameStart: number, relPath: string): TextEdit[] | undefined {
  const found: ts.ClassDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (found.length > 0) return;
    if (ts.isClassDeclaration(node) && node.name !== undefined && node.name.getStart(sf) === classNameStart) {
      found.push(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const decl = found[0];
  if (decl === undefined) return undefined;
  const call = assetDecoratorCalls(sf, ["blueprint", "struct"]).find((c) => c.parent.parent === decl);
  if (call === undefined) return undefined;
  const option = `path: ${JSON.stringify(relPath)}`;
  const first = call.arguments[0];
  if (first === undefined) {
    const close = call.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.CloseParenToken);
    if (close === undefined) return undefined;
    return [{ start: close.getStart(sf), length: 0, newText: `{ ${option} }` }];
  }
  if (!ts.isObjectLiteralExpression(first)) return undefined;
  const hasPath = first.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "path");
  if (hasPath) return undefined;
  const firstProp = first.properties[0];
  if (firstProp === undefined) return [{ start: first.getStart(sf), length: first.getEnd() - first.getStart(sf), newText: `{ ${option} }` }];
  const open = sf.getLineAndCharacterOfPosition(first.getStart(sf)).line;
  const propLine = sf.getLineAndCharacterOfPosition(firstProp.getStart(sf)).line;
  if (open === propLine) return [{ start: firstProp.getStart(sf), length: 0, newText: `${option}, ` }];
  const lineStart = sf.text.lastIndexOf("\n", firstProp.getStart(sf) - 1) + 1;
  const indent = sf.text.slice(lineStart, firstProp.getStart(sf));
  return [{ start: firstProp.getStart(sf), length: 0, newText: `${option},\n${indent}` }];
}

/**
 * ABFC2078: `@event Name()` -> `@override override Name()`. Replaces the decorator covering [start, end) with `@override`, inserts the
 * TS `override` modifier before the method name (before `async` when present) if missing, and imports `override` from `@abfc/runtime`.
 */
export function useOverrideFix(sf: ts.SourceFile, start: number, end: number): TextEdit[] | undefined {
  let found: ts.MethodDeclaration | undefined;
  let decorator: ts.Decorator | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isMethodDeclaration(node)) {
      const d = (ts.getDecorators(node) ?? []).find((x) => x.getStart(sf) <= start && end <= x.getEnd());
      if (d !== undefined) {
        found = node;
        decorator = d;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (found === undefined || decorator === undefined) return undefined;
  const binding = runtimeBinding(sf, "override");
  const at = decorator.getStart(sf);
  const edits: TextEdit[] = [];
  let decoratorEdit: TextEdit = { start: at, length: decorator.getEnd() - at, newText: `@${binding.name}` };
  if (binding.edit !== undefined) {
    if (binding.edit.start === at) decoratorEdit = { ...decoratorEdit, newText: binding.edit.newText + decoratorEdit.newText };
    else edits.push(binding.edit);
  }
  edits.push(decoratorEdit);
  const mods = ts.getModifiers(found) ?? [];
  if (!mods.some((k) => k.kind === ts.SyntaxKind.OverrideKeyword)) {
    const asyncMod = mods.find((k) => k.kind === ts.SyntaxKind.AsyncKeyword);
    edits.push({ start: (asyncMod ?? found.name).getStart(sf), length: 0, newText: "override " });
  }
  return edits;
}
