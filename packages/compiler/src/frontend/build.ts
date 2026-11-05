// HIR builder: checks the Phase 1 TypeScript subset and resolves every name through the stub tags.
import ts from "typescript";
import type { Diagnostic, Profile, Span } from "@abfc/ir";
import type { BpType, HirClass, HirEvent, HirExpr, HirProgram, HirStmt, LocalId } from "../hir.js";
import { DiagSink, Fail, relFile, spanOf } from "./diag.js";
import type { LoadedProgram } from "./program.js";
import { bpPathOf, bpTagsOfSymbol, bpTypeOf, bpTypeOfMember, classInfo, functionInfo, resolveAlias, splitMemberPath } from "./tags.js";
import type { FunctionInfo } from "./tags.js";

const BLUEPRINT_META = "/Script/Engine.BlueprintGeneratedClass";
const NUMERIC = new Set(["int", "int64", "byte", "float", "double", "real"]);
const STRINGY = new Set(["name", "text", "string"]);
const CONTAINERS = new Set(["Map", "Set", "WeakMap", "WeakSet", "ReadonlyMap", "ReadonlySet"]);

type EqKind = "object" | "name" | "string" | "int" | "real" | "bool" | "byte";

export function kindOfBpType(t: string): EqKind | undefined {
  if (t === "bool") return "bool";
  if (t === "int" || t === "int64") return "int";
  if (t === "byte" || t.startsWith("enum:")) return "byte";
  if (t === "float" || t === "double" || t === "real") return "real";
  if (t === "name") return "name";
  if (t === "string") return "string";
  if (t.startsWith("object:") || t.startsWith("class:") || t.startsWith("interface:")) return "object";
  return undefined;
}

interface LocalInfo {
  id: LocalId;
  name: string;
  type: BpType;
  poison: boolean;
  /** Set for locals that hold a multi-output / exec-output call result. */
  fn?: FunctionInfo;
}

/** `{ module, name }` of an import specifier an identifier refers to (undefined for anything else). */
export function importOf(checker: ts.TypeChecker, id: ts.Identifier): { module: string; name: string } | undefined {
  const decl = checker.getSymbolAtLocation(id)?.declarations?.[0];
  if (decl && ts.isImportSpecifier(decl)) {
    const spec = decl.parent.parent.parent.moduleSpecifier;
    if (ts.isStringLiteral(spec)) return { module: spec.text, name: (decl.propertyName ?? decl.name).text };
  }
  return undefined;
}

/** Name of the `@abfc/runtime` function a decorator or call expression refers to. */
export function runtimeName(checker: ts.TypeChecker, expr: ts.Expression): string | undefined {
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  if (!ts.isIdentifier(callee)) return undefined;
  const imp = importOf(checker, callee);
  return imp && imp.module === "@abfc/runtime" ? imp.name : undefined;
}

/** `path` option of the `@blueprint({ path })` decorator of a class declaration. */
export function blueprintPathOf(checker: ts.TypeChecker, decl: ts.ClassDeclaration): string | undefined {
  for (const d of ts.getDecorators(decl) ?? []) {
    if (runtimeName(checker, d.expression) !== "blueprint" || !ts.isCallExpression(d.expression)) continue;
    const opts = d.expression.arguments[0];
    if (!opts || !ts.isObjectLiteralExpression(opts)) continue;
    for (const p of opts.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "path") {
        if (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) return p.initializer.text;
      }
    }
  }
  return undefined;
}

/** `<path>.<AssetName>_C` for a package path. */
export function classPathOf(path: string): string {
  return `${path}.${path.slice(path.lastIndexOf("/") + 1)}_C`;
}

function children(e: HirExpr): HirExpr[] {
  switch (e.k) {
    case "getOn": return [e.obj];
    case "field": return [e.obj];
    case "out": return [e.call];
    case "call": return [...(e.target ? [e.target] : []), ...e.args.map((a) => a.value)];
    case "cast": return [e.value];
    case "optional": return [e.value, e.then];
    case "isValid": return [e.value];
    case "eq": return [e.a, e.b];
    case "not": return [e.e];
    case "and": return [e.a, e.b];
    case "or": return [e.a, e.b];
    case "length": return [e.array];
    default: return [];
  }
}

function some(e: HirExpr, pred: (x: HirExpr) => boolean): boolean {
  return pred(e) || children(e).some((c) => some(c, pred));
}

function directExprs(s: HirStmt): HirExpr[] {
  switch (s.k) {
    case "expr": return [s.e];
    case "setSelf": return [s.value];
    case "const": return [s.init];
    case "if": return [s.cond];
    case "forOf": return [s.array];
    default: return [];
  }
}

function consumesCast(next: HirStmt, id: LocalId): boolean {
  const isLocal = (x: HirExpr): boolean => x.k === "local" && x.id === id;
  if (next.k === "if" && some(next.cond, isLocal)) return true;
  return directExprs(next).some((e) => some(e, (x) => x.k === "optional" && isLocal(x.value)));
}

function consumesExec(next: HirStmt, id: LocalId): boolean {
  return next.k === "if" && some(next.cond, (x) => x.k === "execIs" && x.local === id);
}

class HirBuilder {
  readonly sink: DiagSink;
  readonly classMeta: Record<string, string> = {};
  readonly classes: HirClass[] = [];
  private readonly checker: ts.TypeChecker;
  private readonly mod: string;

  private cls!: HirClass;
  private body!: ts.Node;
  private locals = new Map<ts.Symbol, LocalInfo>();
  private params = new Map<ts.Symbol, { name: string; type: BpType }>();
  private nextLocal = 0;
  private holes = new Map<ts.Node, HirExpr>();
  private handled = new Set<ts.Node>();
  private readonly callInfo = new WeakMap<object, FunctionInfo>();

  constructor(loaded: LoadedProgram, mod: string) {
    this.checker = loaded.checker;
    this.mod = mod;
    this.sink = new DiagSink(loaded.projectDir);
  }

  private sp(node: ts.Node): Span {
    return spanOf(node, this.sink.root);
  }

  // ---- classes ----

  classDecl(node: ts.ClassDeclaration): void {
    const bp = (ts.getDecorators(node) ?? []).find((d) => runtimeName(this.checker, d.expression) === "blueprint");
    if (!bp) return;
    const name = node.name?.text ?? "(anonymous)";
    let path: string | undefined;
    let parentOption: string | undefined;
    const opts = ts.isCallExpression(bp.expression) ? bp.expression.arguments[0] : undefined;
    if (opts && ts.isObjectLiteralExpression(opts)) {
      for (const p of opts.properties) {
        const key = ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        const lit = ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) ? p.initializer.text : undefined;
        if (key === "path") path = lit;
        else if (key === "parent") parentOption = lit;
        else this.sink.warning("ABFC2099", `@blueprint option "${key ?? "?"}" is not supported in Phase 1`, p);
      }
    }
    if (path === undefined || !path.startsWith(`/${this.mod}/`) || path.endsWith("/")) {
      this.sink.error("ABFC2001", `@blueprint path of ${name} must be a string literal under "/${this.mod}/"`, opts ?? bp);
      return;
    }

    const ext = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    let parent: string | undefined = parentOption;
    if (ext === undefined) {
      this.sink.error("ABFC2099", `${name} must extend a Blueprint or engine class`, node.name ?? node);
      return;
    }
    const extSym = this.checker.getSymbolAtLocation(ext);
    const extInfo = extSym ? classInfo(resolveAlias(this.checker, extSym)) : undefined;
    if (extInfo === undefined) {
      this.sink.error("ABFC2060", `parent class of ${name} has no Blueprint metadata (@bpPath)`, ext);
      return;
    }
    this.classMeta[extInfo.path] = extInfo.meta;
    parent ??= extInfo.path;

    const cls: HirClass = {
      name,
      path,
      classPath: classPathOf(path),
      parent,
      span: this.sp(node.name ?? node),
      events: [],
      manualUnits: this.manualUnits(node),
    };
    this.classMeta[cls.classPath] = BLUEPRINT_META;

    for (const m of node.members) {
      if (ts.isSemicolonClassElement(m)) continue;
      if (ts.isMethodDeclaration(m)) {
        const names = (ts.getDecorators(m) ?? []).map((d) => runtimeName(this.checker, d.expression));
        if (names.includes("event")) {
          const ev = this.event(m, cls);
          if (ev) cls.events.push(ev);
        } else {
          this.sink.error("ABFC2099", `method ${m.name.getText()} is not supported in Phase 1 (only @event methods)`, m.name);
        }
        continue;
      }
      this.sink.error("ABFC2099", `class member of kind ${ts.SyntaxKind[m.kind]} is not supported in Phase 1`, m);
    }
    this.classes.push(cls);
  }

  private manualUnits(node: ts.ClassDeclaration): string[] {
    const sym = node.name ? this.checker.getSymbolAtLocation(node.name) : undefined;
    if (!sym) return [];
    const type = this.checker.getDeclaredTypeOfSymbol(sym);
    const out: string[] = [];
    for (const p of this.checker.getPropertiesOfType(type)) {
      const isMethod = (p.declarations ?? []).some((d) => ts.isMethodSignature(d) || ts.isMethodDeclaration(d));
      if (isMethod && bpTagsOfSymbol(p).has("bpHandMade")) out.push(p.name);
    }
    return out.sort();
  }

  private event(m: ts.MethodDeclaration, cls: HirClass): HirEvent | undefined {
    if (!ts.isIdentifier(m.name) || !m.body) {
      this.sink.error("ABFC2099", "an @event method needs an identifier name and a body", m.name);
      return undefined;
    }
    this.cls = cls;
    this.body = m.body;
    this.locals = new Map();
    this.params = new Map();
    this.holes = new Map();
    this.handled = new Set();
    this.nextLocal = 0;
    const params: HirEvent["params"] = [];
    for (const p of m.parameters) {
      if (!ts.isIdentifier(p.name)) {
        this.sink.error("ABFC2099", "destructured parameters are not supported in Phase 1", p);
        continue;
      }
      const t = this.checker.getTypeAtLocation(p);
      let type = bpTypeOf(this.checker, t);
      if (type === undefined) {
        if (t.flags & ts.TypeFlags.NumberLike) {
          this.sink.error("ABFC2014", `number kind of parameter ${p.name.text} is not inferable: use int, int64, byte, float or double`, p);
          type = "number";
        } else {
          this.sink.error("ABFC2099", `parameter ${p.name.text} has a type without a Blueprint equivalent`, p);
          type = "unknown";
        }
      }
      this.noteTypes(t);
      const sym = this.checker.getSymbolAtLocation(p.name);
      if (sym) this.params.set(sym, { name: p.name.text, type });
      params.push({ name: p.name.text, type });
    }
    const body = this.stmts(m.body.statements);
    return { name: m.name.text, params, body, span: this.sp(m.name) };
  }

  // ---- statements ----

  private stmts(list: readonly ts.Statement[]): HirStmt[] {
    const items: Array<{ node: ts.Statement; hir: HirStmt | undefined }> = [];
    for (const node of list) {
      if (ts.isEmptyStatement(node)) continue;
      items.push({ node, hir: this.stmt(node) });
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || it.hir === undefined || it.hir.k !== "const") continue;
      const next = items[i + 1];
      const id = it.hir.local;
      const init = it.hir.init;
      if (init.k === "cast") {
        const ok = next === undefined ? false : next.hir === undefined || consumesCast(next.hir, id);
        if (!ok) this.sink.error("ABFC2050", `cast result "${it.hir.name}" must be consumed by the next statement (if (!${it.hir.name}), if (${it.hir.name}) or ${it.hir.name}?.)`, it.node);
      } else if (init.k === "call" && init.execOutputs !== null) {
        const ok = next === undefined ? false : next.hir === undefined || consumesExec(next.hir, id);
        if (!ok) this.sink.error("ABFC2052", `exec result "${it.hir.name}" must be branched by the next statement (if (${it.hir.name}.exec === "...") )`, it.node);
      }
    }
    return items.flatMap((i) => (i.hir ? [i.hir] : []));
  }

  private block(s: ts.Statement): HirStmt[] {
    return this.stmts(ts.isBlock(s) ? s.statements : [s]);
  }

  private stmt(node: ts.Statement): HirStmt | undefined {
    try {
      return this.stmtInner(node);
    } catch (e) {
      if (e instanceof Fail) return undefined;
      throw e;
    }
  }

  private stmtInner(node: ts.Statement): HirStmt {
    const f: DiagSink = this.sink;
    if (ts.isVariableStatement(node)) return this.constStmt(node);
    if (ts.isExpressionStatement(node)) return this.exprStmt(node);
    if (ts.isIfStatement(node)) {
      const cond = this.expr(node.expression, undefined, true);
      const then = this.block(node.thenStatement);
      const els = node.elseStatement ? this.block(node.elseStatement) : [];
      return { k: "if", cond, then, else: els, span: this.sp(node) };
    }
    if (ts.isReturnStatement(node)) {
      if (node.expression) f.fail("ABFC2099", "returning a value is not supported in Phase 1", node);
      return { k: "return", span: this.sp(node) };
    }
    if (ts.isForOfStatement(node)) return this.forOf(node);
    if (ts.isTryStatement(node) || ts.isThrowStatement(node)) f.fail("ABFC2020", "try/catch/throw are not supported", node);
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) f.fail("ABFC2020", "local functions and classes are not supported", node);
    return f.fail("ABFC2099", `statement of kind ${ts.SyntaxKind[node.kind]} is not supported in Phase 1`, node);
  }

  private constStmt(node: ts.VariableStatement): HirStmt {
    const f: DiagSink = this.sink;
    const list = node.declarationList;
    if (!(list.flags & ts.NodeFlags.Const)) f.fail("ABFC2099", "only const declarations are supported in Phase 1", node);
    const d = list.declarations[0];
    if (list.declarations.length !== 1 || !d) f.fail("ABFC2099", "declare one const per statement", node);
    if (!ts.isIdentifier(d.name)) f.fail("ABFC2099", "destructuring is not supported in Phase 1", d.name);
    if (!d.initializer) f.fail("ABFC2099", "a const needs an initializer", d);
    const sym = this.checker.getSymbolAtLocation(d.name);
    const declType = this.checker.getTypeAtLocation(d.name);
    if (declType.flags & ts.TypeFlags.Any) f.fail("ABFC2020", "'any' is not supported", d.name);
    let init: HirExpr;
    try {
      init = this.expr(d.initializer);
    } catch (e) {
      if (e instanceof Fail && sym) this.locals.set(sym, { id: -1, name: d.name.text, type: "unknown", poison: true });
      throw e;
    }
    const id = this.nextLocal++;
    const fn = init.type === "result" ? this.callInfo.get(init) : undefined;
    if (sym) this.locals.set(sym, { id, name: d.name.text, type: init.type, poison: false, ...(fn ? { fn } : {}) });
    return { k: "const", local: id, name: d.name.text, init, uses: sym ? this.countUses(sym, d.name) : 0, span: this.sp(node) };
  }

  private countUses(sym: ts.Symbol, declName: ts.Node): number {
    let n = 0;
    const walk = (x: ts.Node): void => {
      if (ts.isIdentifier(x) && x !== declName && this.checker.getSymbolAtLocation(x) === sym) n++;
      ts.forEachChild(x, walk);
    };
    walk(this.body);
    return n;
  }

  private exprStmt(node: ts.ExpressionStatement): HirStmt {
    const f: DiagSink = this.sink;
    const e = node.expression;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken) return this.assign(e);
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) f.fail("ABFC2099", "compound assignment is not supported in Phase 1", e);
    }
    if (ts.isAwaitExpression(e)) f.fail("ABFC2099", "await is not supported in Phase 1", e);
    const h = this.expr(e);
    if (h.k !== "call" && h.k !== "optional") f.fail("ABFC2099", "this expression statement has no effect", e);
    return { k: "expr", e: h, span: this.sp(node) };
  }

  private assign(e: ts.BinaryExpression): HirStmt {
    const f: DiagSink = this.sink;
    const left = e.left;
    if (!ts.isPropertyAccessExpression(left) || left.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      return f.fail("ABFC2099", "assignment is only supported as this.<variable> = value", e);
    }
    const sym = this.checker.getSymbolAtLocation(left.name);
    if (!sym) return f.fail("ABFC2060", `member ${left.name.text} has no Blueprint metadata (@bpPath)`, left.name);
    const type = bpTypeOfMember(sym);
    if (type === undefined) {
      if (bpPathOf(sym) === undefined) f.fail("ABFC2060", `member ${left.name.text} has no Blueprint metadata (@bpPath)`, left.name);
      return f.fail("ABFC2099", `${left.name.text} is not a Blueprint variable`, left.name);
    }
    const name = splitMemberPath(bpPathOf(sym) ?? "")?.name ?? left.name.text;
    const value = this.expr(e.right, type);
    return { k: "setSelf", name, type, value, span: this.sp(e) };
  }

  private forOf(node: ts.ForOfStatement): HirStmt {
    const f: DiagSink = this.sink;
    if (node.awaitModifier) f.fail("ABFC2099", "for await is not supported", node);
    const init = node.initializer;
    if (!ts.isVariableDeclarationList(init) || !(init.flags & ts.NodeFlags.Const) || init.declarations.length !== 1) {
      return f.fail("ABFC2099", "for..of needs `const x`", node.initializer);
    }
    const d = init.declarations[0];
    if (!d || !ts.isIdentifier(d.name)) return f.fail("ABFC2099", "for..of needs a plain identifier", init);
    const array = this.expr(node.expression);
    if (!array.type.startsWith("array:")) f.fail("ABFC2099", "for..of is only supported over Blueprint arrays", node.expression);
    const elem = array.type.slice("array:".length);
    const sym = this.checker.getSymbolAtLocation(d.name);
    const id = this.nextLocal++;
    if (sym) this.locals.set(sym, { id, name: d.name.text, type: elem, poison: false });
    const body = this.block(node.statement);
    return { k: "forOf", local: id, name: d.name.text, array, elem, body, span: this.sp(node) };
  }

  // ---- expressions ----

  private noteTypes(type: ts.Type): void {
    const t = this.checker.getNonNullableType(type);
    if (t.isUnion()) {
      for (const m of t.types) this.noteTypes(m);
      return;
    }
    if (this.checker.isArrayType(t)) {
      const arg = this.checker.getTypeArguments(t as ts.TypeReference)[0];
      if (arg) this.noteTypes(arg);
      return;
    }
    const sym = t.getSymbol();
    if (sym) this.noteSymbol(sym);
  }

  private noteSymbol(sym: ts.Symbol): void {
    const ci = classInfo(sym);
    if (ci && ci.kind === "class") this.classMeta[ci.path] = ci.meta;
  }

  private lit(node: ts.Expression, value: string | number | boolean | null, type: string): HirExpr {
    return { k: "lit", value, type, span: this.sp(node) };
  }

  private expr(node: ts.Expression, expected?: BpType, inCond = false): HirExpr {
    const hole = this.holes.get(node);
    if (hole) return hole;
    if (ts.isParenthesizedExpression(node)) return this.expr(node.expression, expected, inCond);
    if (ts.isNonNullExpression(node)) return this.expr(node.expression, expected, inCond);

    const tsType = this.checker.getTypeAtLocation(node);
    if (tsType.flags & ts.TypeFlags.Any && !("intrinsicName" in tsType && (tsType as { intrinsicName?: string }).intrinsicName === "error")) {
      this.sink.fail("ABFC2020", "'any' is not supported", node);
    }
    const tsym = tsType.getSymbol() ?? tsType.aliasSymbol;
    if (tsym && CONTAINERS.has(tsym.name)) this.sink.fail("ABFC2040", `${tsym.name} is not supported in Phase 1`, node);

    if (node.flags & ts.NodeFlags.OptionalChain && (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node) || ts.isElementAccessExpression(node))) {
      const q = this.chainRoot(node);
      if (q) return this.optional(node, q);
    }

    const out = this.exprInner(node, expected, inCond);
    this.noteTypes(tsType);
    return out;
  }

  /** The first-evaluated `?.` of an optional chain that is not being resolved yet. */
  private chainRoot(node: ts.Expression): ts.PropertyAccessExpression | ts.CallExpression | ts.ElementAccessExpression | undefined {
    let found: ts.PropertyAccessExpression | ts.CallExpression | ts.ElementAccessExpression | undefined;
    let cur: ts.Expression = node;
    while (cur.flags & ts.NodeFlags.OptionalChain) {
      if (ts.isNonNullExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (!(ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur) || ts.isElementAccessExpression(cur))) break;
      if (cur.questionDotToken && !this.handled.has(cur)) found = cur;
      cur = cur.expression;
    }
    return found;
  }

  private optional(node: ts.Expression, q: ts.PropertyAccessExpression | ts.CallExpression | ts.ElementAccessExpression): HirExpr {
    const recv = q.expression;
    const value = this.expr(recv);
    this.handled.add(q);
    this.holes.set(recv, { k: "hole", type: value.type, span: this.sp(recv) });
    let then: HirExpr;
    try {
      then = this.expr(node);
    } finally {
      this.holes.delete(recv);
      this.handled.delete(q);
    }
    return { k: "optional", value, then, type: then.type, span: this.sp(node) };
  }

  private exprInner(node: ts.Expression, expected: BpType | undefined, inCond: boolean): HirExpr {
    const f: DiagSink = this.sink;
    const sp = this.sp(node);
    switch (node.kind) {
      case ts.SyntaxKind.ThisKeyword:
        return { k: "self", type: `object:${this.cls.classPath}`, span: sp };
      case ts.SyntaxKind.NullKeyword:
        return { k: "lit", value: null, type: "null", span: sp };
      case ts.SyntaxKind.TrueKeyword:
        return { k: "lit", value: true, type: "bool", span: sp };
      case ts.SyntaxKind.FalseKeyword:
        return { k: "lit", value: false, type: "bool", span: sp };
      case ts.SyntaxKind.NumericLiteral:
        return this.lit(node, Number((node as ts.NumericLiteral).text), expected !== undefined && NUMERIC.has(expected) ? expected : "number");
      case ts.SyntaxKind.StringLiteral:
        return this.lit(node, (node as ts.StringLiteral).text, expected !== undefined && STRINGY.has(expected) ? expected : "string");
      case ts.SyntaxKind.Identifier:
        return this.identifier(node as ts.Identifier, sp);
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const u = node as ts.PrefixUnaryExpression;
        if (u.operator === ts.SyntaxKind.ExclamationToken) return { k: "not", e: this.expr(u.operand, "bool", inCond), type: "bool", span: sp };
        if (u.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(u.operand)) {
          return this.lit(node, -Number(u.operand.text), expected !== undefined && NUMERIC.has(expected) ? expected : "number");
        }
        return f.fail("ABFC2099", "this unary operator is not supported in Phase 1", node);
      }
      case ts.SyntaxKind.PropertyAccessExpression:
        return this.propAccess(node as ts.PropertyAccessExpression, sp);
      case ts.SyntaxKind.CallExpression:
        return this.callExpr(node as ts.CallExpression, sp);
      case ts.SyntaxKind.BinaryExpression:
        return this.binary(node as ts.BinaryExpression, inCond, sp);
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
      case ts.SyntaxKind.ClassExpression:
        return f.fail("ABFC2020", "closures and function expressions are not supported", node);
      case ts.SyntaxKind.NewExpression:
        return f.fail("ABFC2020", "`new` is not supported", node);
      case ts.SyntaxKind.SpreadElement:
      case ts.SyntaxKind.YieldExpression:
        return f.fail("ABFC2020", "spread and generators are not supported", node);
      case ts.SyntaxKind.ArrayLiteralExpression: {
        const spread = (node as ts.ArrayLiteralExpression).elements.find((el) => ts.isSpreadElement(el));
        if (spread) f.fail("ABFC2020", "spread is not supported", spread);
        return f.fail("ABFC2099", "array literals are not supported in Phase 1", node);
      }
      case ts.SyntaxKind.AwaitExpression:
        return f.fail("ABFC2099", "await is not supported in Phase 1", node);
      case ts.SyntaxKind.ConditionalExpression:
        return f.fail("ABFC2099", "the conditional operator `?:` is not supported in Phase 1", node);
      case ts.SyntaxKind.TemplateExpression:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TaggedTemplateExpression:
        return f.fail("ABFC2099", "template strings are not supported in Phase 1", node);
      default:
        return f.fail("ABFC2099", `expression of kind ${ts.SyntaxKind[node.kind]} is not supported in Phase 1`, node);
    }
  }

  private identifier(node: ts.Identifier, sp: Span): HirExpr {
    const sym = this.checker.getSymbolAtLocation(node);
    const local = sym ? this.locals.get(sym) : undefined;
    if (local) {
      if (local.poison) throw new Fail();
      return { k: "local", id: local.id, type: local.type, span: sp };
    }
    const par = sym ? this.params.get(sym) : undefined;
    if (par) return { k: "param", name: par.name, type: par.type, span: sp };
    return this.sink.fail("ABFC2099", `identifier "${node.text}" cannot be used as a value in Phase 1`, node);
  }

  private localOf(node: ts.Expression): LocalInfo | undefined {
    if (!ts.isIdentifier(node)) return undefined;
    const sym = this.checker.getSymbolAtLocation(node);
    return sym ? this.locals.get(sym) : undefined;
  }

  private structPathOf(type: ts.Type): string | undefined {
    const sym = this.checker.getNonNullableType(type).getSymbol();
    const ci = sym ? classInfo(sym) : undefined;
    return ci && ci.kind === "struct" ? ci.path : undefined;
  }

  private propAccess(node: ts.PropertyAccessExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    if (ts.isPrivateIdentifier(node.name)) return f.fail("ABFC2099", "private names are not supported", node.name);
    const name = node.name.text;
    const recv = node.expression;
    const memberSym = this.checker.getSymbolAtLocation(node.name);

    if (recv.kind === ts.SyntaxKind.ThisKeyword) {
      const type = memberSym ? bpTypeOfMember(memberSym) : undefined;
      if (type === undefined) {
        if (memberSym && bpPathOf(memberSym) !== undefined) f.fail("ABFC2099", `${name} is not a Blueprint variable`, node.name);
        return f.fail("ABFC2060", `member ${name} has no Blueprint metadata (@bpPath)`, node.name);
      }
      const bpName = splitMemberPath(bpPathOf(memberSym!) ?? "")?.name ?? name;
      return { k: "getSelf", name: bpName, type, span: sp };
    }

    const local = this.localOf(recv);
    if (name === "exec" && local?.fn?.execOutputs) {
      return f.fail("ABFC2053", "`.exec` may only be used as `r.exec === \"Pin\"` or `r.exec !== \"Pin\"` in an if condition", node);
    }
    const obj = this.expr(recv);

    if (name === "length" && obj.type.startsWith("array:")) return { k: "length", array: obj, arrayType: obj.type, type: "int", span: sp };

    if (local?.fn) {
      const pin = local.fn.pinOfTs.get(name) ?? name;
      const o = local.fn.outs.find((x) => x.pin === pin);
      if (!o) return f.fail("ABFC2099", `${local.name} has no output "${name}"`, node.name);
      return { k: "out", call: obj, pin, type: o.type, span: sp };
    }

    const recvType = this.checker.getTypeAtLocation(recv);
    const structPath = this.structPathOf(recvType);
    if (structPath !== undefined) {
      const type = (memberSym ? bpTypeOfMember(memberSym) : undefined) ?? (memberSym ? bpTypeOf(this.checker, this.checker.getTypeAtLocation(node)) : undefined) ?? "unknown";
      return { k: "field", obj, struct: structPath, name, type, span: sp };
    }

    const path = memberSym ? bpPathOf(memberSym) : undefined;
    const mp = path === undefined ? undefined : splitMemberPath(path);
    if (!memberSym || !mp) return f.fail("ABFC2060", `member ${name} has no Blueprint metadata (@bpPath)`, node.name);
    const type = bpTypeOfMember(memberSym) ?? bpTypeOf(this.checker, this.checker.getTypeAtLocation(node));
    if (type === undefined) return f.fail("ABFC2099", `${name} is not a Blueprint variable`, node.name);
    return { k: "getOn", obj, owner: mp.owner, name: mp.name, type, span: sp };
  }

  private classArg(arg: ts.Expression | undefined): { path: string; meta: string; castPin: string | null; sym: ts.Symbol } | undefined {
    if (!arg) return undefined;
    const s = this.checker.getSymbolAtLocation(arg);
    if (!s) return undefined;
    const sym = resolveAlias(this.checker, s);
    const ci = classInfo(sym);
    return ci ? { path: ci.path, meta: ci.meta, castPin: ci.castPin, sym } : undefined;
  }

  private callExpr(node: ts.CallExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      const rt = runtimeName(this.checker, node);
      if (rt === "cast") {
        if (node.arguments.length !== 2) f.fail("ABFC2099", "cast(value, Class) takes two arguments", node);
        const arg0 = node.arguments[0]!;
        const value = this.expr(arg0);
        const ci = this.classArg(node.arguments[1]);
        if (!ci) return f.fail("ABFC2060", "the cast target has no Blueprint metadata (@bpPath)", node.arguments[1] ?? node);
        if (ci.castPin === null) return f.fail("ABFC3004", `no cast pin known for ${ci.path}; run "abfc stubs"`, node);
        this.classMeta[ci.path] = ci.meta;
        return { k: "cast", value, target: ci.path, castPin: ci.castPin, type: `object:${ci.path}`, span: sp };
      }
      if (rt === "isValid") {
        if (node.arguments.length !== 1) f.fail("ABFC2099", "isValid(value) takes one argument", node);
        return { k: "isValid", value: this.expr(node.arguments[0]!), type: "bool", span: sp };
      }
      if (callee.text === "eval") return f.fail("ABFC2020", "eval is not supported", node);
      return f.fail("ABFC2099", `call of "${callee.text}" is not supported in Phase 1`, node);
    }
    if (!ts.isPropertyAccessExpression(callee)) return f.fail("ABFC2099", "only method and library calls are supported in Phase 1", node);

    const sym = this.checker.getSymbolAtLocation(callee.name);
    const fi = sym ? functionInfo(sym) : undefined;
    if (!fi) return f.fail("ABFC2060", `function ${callee.name.text} has no Blueprint metadata (@bpPath)`, callee.name);

    if (fi.execOutputs !== null) {
      const p = node.parent;
      const okParent = ts.isExpressionStatement(p) || (ts.isVariableDeclaration(p) && p.initializer === node);
      if (!okParent) f.fail("ABFC2052", "the result of a function with exec outputs must be stored in a const and branched by the next statement", node);
    }

    let target: HirExpr | null = null;
    if (fi.static) {
      const ns = this.checker.getSymbolAtLocation(callee.expression);
      if (ns) this.noteSymbol(resolveAlias(this.checker, ns));
    } else if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) {
      target = this.expr(callee.expression);
    }

    const args: Array<{ pin: string; value: HirExpr }> = [];
    node.arguments.forEach((a) => {
      const p = fi.params[args.length];
      if (!p) f.fail("ABFC2099", `too many arguments for ${fi.name}`, a);
      args.push({ pin: p.pin, value: this.expr(a, p.type) });
    });

    const multi = fi.execOutputs !== null || fi.outs.length > 1 || (fi.outs.length === 1 && fi.outs[0]?.pin !== "ReturnValue");
    const type = multi ? "result" : (fi.outs[0]?.type ?? "void");
    const out: HirExpr = {
      k: "call",
      owner: fi.owner === this.cls.classPath ? null : fi.owner,
      name: fi.name,
      target,
      static: fi.static,
      pure: fi.pure,
      execOutputs: fi.execOutputs,
      args,
      outs: fi.outs,
      type,
      span: sp,
    };
    this.callInfo.set(out, fi);
    return out;
  }

  private isLiteralNode(n: ts.Expression): boolean {
    let x = n;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    return (
      ts.isNumericLiteral(x) ||
      ts.isStringLiteral(x) ||
      x.kind === ts.SyntaxKind.TrueKeyword ||
      x.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(x.operand))
    );
  }

  private binary(node: ts.BinaryExpression, inCond: boolean, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const op = node.operatorToken.kind;
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return f.fail("ABFC2011", "`==` and `!=` are not supported; use `===` and `!==`", node);
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
        return this.eqExpr(node, false, sp);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        return this.eqExpr(node, true, sp);
      case ts.SyntaxKind.AmpersandAmpersandToken:
      case ts.SyntaxKind.BarBarToken: {
        if (!inCond) f.fail("ABFC2099", "`&&` and `||` are only supported inside if conditions in Phase 1", node);
        const a = this.expr(node.left, "bool", true);
        const b = this.expr(node.right, "bool", true);
        return op === ts.SyntaxKind.AmpersandAmpersandToken ? { k: "and", a, b, type: "bool", span: sp } : { k: "or", a, b, type: "bool", span: sp };
      }
      case ts.SyntaxKind.SlashToken: {
        const kinds = [node.left, node.right].map((x) => {
          const t = bpTypeOf(this.checker, this.checker.getTypeAtLocation(x));
          return t === undefined ? undefined : kindOfBpType(t);
        });
        if (kinds.includes("int") || kinds.includes("byte")) f.fail("ABFC2010", "`/` on integer values is not supported; use idiv(a, b)", node);
        return f.fail("ABFC2099", "arithmetic is not supported in Phase 1", node);
      }
      default:
        return f.fail("ABFC2099", `operator ${node.operatorToken.getText()} is not supported in Phase 1`, node.operatorToken);
    }
  }

  private eqExpr(node: ts.BinaryExpression, negate: boolean, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const strip = (x: ts.Expression): ts.Expression => {
      let y = x;
      while (ts.isParenthesizedExpression(y)) y = y.expression;
      return y;
    };
    const l = strip(node.left);
    const r = strip(node.right);

    const isNull = (x: ts.Expression): boolean => x.kind === ts.SyntaxKind.NullKeyword;
    if (isNull(l) || isNull(r)) {
      const v = this.expr(isNull(r) ? l : r);
      const valid: HirExpr = { k: "isValid", value: v, type: "bool", span: sp };
      return negate ? valid : { k: "not", e: valid, type: "bool", span: sp };
    }

    // r.exec === "Pin"
    const execSide = [l, r].find((x): x is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(x) && x.name.text === "exec");
    if (execSide) {
      const local = this.localOf(execSide.expression);
      if (local?.fn?.execOutputs) {
        const other = execSide === l ? r : l;
        if (!ts.isStringLiteral(other)) f.fail("ABFC2053", "`.exec` must be compared with a string literal pin name", node);
        if (!local.fn.execOutputs.includes(other.text)) f.fail("ABFC2099", `${local.name}.exec has no pin "${other.text}"`, other);
        return { k: "execIs", local: local.id, pin: other.text, negate, type: "bool", span: sp };
      }
    }

    let a: HirExpr;
    let b: HirExpr;
    if (this.isLiteralNode(l) && !this.isLiteralNode(r)) {
      b = this.expr(r);
      a = this.expr(l, b.type);
    } else {
      a = this.expr(l);
      b = this.expr(r, a.type);
    }
    const ka = kindOfBpType(a.type);
    const kb = kindOfBpType(b.type);
    if (ka === undefined && kb === undefined) return f.fail("ABFC2014", "the number kind of this comparison is not inferable; use int, int64, byte, float or double values", node);
    if (ka !== undefined && kb !== undefined && ka !== kb) return f.fail("ABFC2013", `cannot compare ${a.type} with ${b.type} (different Blueprint kinds)`, node);
    const kind = (ka ?? kb)!;
    return { k: "eq", negate, a, b, kind, type: "bool", span: sp };
  }
}

/**
 * Builds the HIR of the class files (or of `only`). Subset violations are ABFC2xxx diagnostics in the result; TypeScript's own
 * diagnostics are in `LoadedProgram.diagnostics`.
 */
export function buildHir(loaded: LoadedProgram, config: { mod: string }, _profile: Profile, only?: readonly ts.SourceFile[]): HirProgram {
  const b = new HirBuilder(loaded, config.mod);
  for (const sf of only ?? loaded.files.classes) {
    for (const st of sf.statements) if (ts.isClassDeclaration(st)) b.classDecl(st);
  }
  return { mod: config.mod, classes: b.classes, classMeta: b.classMeta, diagnostics: b.sink.diagnostics };
}

/** Diagnostics (TypeScript's and the subset checker's) of one file; the entry point of the future ts-plugin. */
export function checkSubset(loaded: LoadedProgram, file: ts.SourceFile, config: { mod: string }, profile: Profile): Diagnostic[] {
  const hir = buildHir(loaded, config, profile, [file]);
  const rel = relFile(loaded.projectDir, file.fileName);
  return [...loaded.diagnostics.filter((d) => d.span?.file === rel), ...hir.diagnostics];
}
