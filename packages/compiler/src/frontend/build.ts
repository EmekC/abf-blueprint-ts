// HIR builder: checks the TypeScript subset and resolves every name through the stub tags.
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
/** `@blueprint` options that set class defaults (applied by the class-defaults pass). */
const CLASS_OPTIONS = new Set(["replicates", "alwaysRelevant", "onlyRelevantToOwner", "netUpdateFrequency", "minNetUpdateFrequency", "tickInterval", "kind"]);
/** Boolean class options -> class default (T3D property name). */
const BOOL_DEFAULTS: Record<string, string> = {
  replicates: "bReplicates",
  alwaysRelevant: "bAlwaysRelevant",
  onlyRelevantToOwner: "bOnlyRelevantToOwner",
};
/** Number class options -> class default (T3D property name). */
const NUMBER_DEFAULTS: Record<string, string> = {
  netUpdateFrequency: "NetUpdateFrequency",
  minNetUpdateFrequency: "MinNetUpdateFrequency",
  tickInterval: "TickInterval",
};
/** Class options that only exist on an Actor (the parent chain must reach `/Script/*.Actor`). */
const ACTOR_ONLY_OPTIONS = new Set(["alwaysRelevant", "onlyRelevantToOwner", "netUpdateFrequency", "minNetUpdateFrequency", "tickInterval"]);
const ARRAY_OWN_ONLY = "an array can only be changed as a statement on an own array variable: this.<Array>.push(x), this.<Array>.splice(i, 1) or this.<Array>.length = 0";
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
    case "callOwn": return e.args.map((a) => a.value);
    case "createWidget": return [e.owner];
    case "spawn": return e.owner ? [e.owner] : [];
    case "arith": return [e.a, e.b];
    case "cmp": return [e.a, e.b];
    case "index": return [e.array, e.index];
    case "arrayFind": return [e.array, e.value];
    default: return [];
  }
}

/** Text of the last JSDoc comment in front of a declaration (decorators included), or undefined. */
function docOf(node: ts.Node): string | undefined {
  const sf = node.getSourceFile();
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  const docs = ranges.map((r) => sf.text.slice(r.pos, r.end)).filter((t) => t.startsWith("/**"));
  const last = docs[docs.length - 1];
  if (last === undefined) return undefined;
  const body = last
    .slice(3, last.length - 2)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*? ?/, "").trimEnd());
  const text = body.join("\n").trim();
  return text === "" ? undefined : text;
}

/** Signature of an owned `@event`/`@override` method, known before any body is built (calls can point forward). */
interface OwnSig {
  node: ts.MethodDeclaration;
  kind: "event" | "override";
  params: HirEvent["params"];
  /** The TypeScript parameter symbols, in order (for binding the body). */
  paramSyms: Array<ts.Symbol | undefined>;
  overrideOf?: string;
}

/** Array methods that change the array; they are statements on an own array variable only. */
const ARRAY_MUTATORS = new Set(["push", "splice"]);

function stripParens(x: ts.Expression): ts.Expression {
  let y = x;
  while (ts.isParenthesizedExpression(y)) y = y.expression;
  return y;
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
    case "setSelfCond": return [s.cond, s.a, s.b];
    case "forCount": return [s.init, s.cond];
    case "arrayOp": return [...(s.value ? [s.value] : []), ...(s.index ? [s.index] : [])];
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
  /** Owned `@event`/`@override` methods of the class being built, by name. */
  private ownSigs = new Map<string, OwnSig>();
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
    let classManagerRow: string | undefined;
    const defaultOpts: Array<{ key: string; prop: string; value: string; node: ts.Node }> = [];
    const opts = ts.isCallExpression(bp.expression) ? bp.expression.arguments[0] : undefined;
    if (opts && ts.isObjectLiteralExpression(opts)) {
      for (const p of opts.properties) {
        const key = ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        const lit = ts.isPropertyAssignment(p) && (ts.isStringLiteral(p.initializer) || ts.isNoSubstitutionTemplateLiteral(p.initializer)) ? p.initializer.text : undefined;
        if (key === "path") path = lit;
        else if (key === "parent") parentOption = lit;
        else if (key === "classManagerRow") classManagerRow = lit;
        else if (key === "tickEnabled") {
          this.sink.error(
            "ABFC2063",
            `@blueprint option "tickEnabled" is not supported yet: writing the saved PrimaryActorTick.bStartWithTickEnabled has not been verified in the editor`,
            p,
          );
        } else if (key !== undefined && CLASS_OPTIONS.has(key)) {
          // class defaults: validated here, applied by the class-defaults pass (design 6.2 pass 5)
          const init = (p as ts.PropertyAssignment).initializer;
          const prop = BOOL_DEFAULTS[key] ?? NUMBER_DEFAULTS[key];
          if (prop === undefined) continue; // "kind": no class default
          const isBool = BOOL_DEFAULTS[key] !== undefined;
          if (isBool && (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword)) {
            defaultOpts.push({ key, prop, value: init.kind === ts.SyntaxKind.TrueKeyword ? "True" : "False", node: p });
          } else if (!isBool && ts.isNumericLiteral(init)) {
            defaultOpts.push({ key, prop, value: Number(init.text).toFixed(6), node: p });
          } else {
            this.sink.error("ABFC2061", `@blueprint option "${key}" must be ${isBool ? "true or false" : "a non-negative number"} written as a literal`, init);
          }
        } else this.sink.warning("ABFC2099", `@blueprint option "${key ?? "?"}" is not supported`, p);
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

    const defaults: Record<string, string> = {};
    const parentIsActor = this.derivesFromActor(this.checker.getDeclaredTypeOfSymbol(resolveAlias(this.checker, extSym!)));
    for (const o of defaultOpts) {
      if (ACTOR_ONLY_OPTIONS.has(o.key) && !parentIsActor) {
        this.sink.error("ABFC2062", `@blueprint option "${o.key}" only applies to an Actor, but ${name} does not derive from Actor`, o.node);
        continue;
      }
      defaults[o.prop] = o.value;
    }

    const cls: HirClass = {
      name,
      path,
      classPath: classPathOf(path),
      parent,
      span: this.sp(node.name ?? node),
      events: [],
      manualUnits: this.manualUnits(node),
      defaults,
      ...(classManagerRow !== undefined ? { classManagerRow } : {}),
    };
    this.classMeta[cls.classPath] = BLUEPRINT_META;

    // Signatures first: a call or delegate reference may point to an event declared further down.
    this.cls = cls;
    this.ownSigs = new Map();
    const parentType = this.checker.getDeclaredTypeOfSymbol(resolveAlias(this.checker, extSym!));
    const methodKind = (m: ts.MethodDeclaration): "event" | "override" | undefined => {
      const names = (ts.getDecorators(m) ?? []).map((d) => runtimeName(this.checker, d.expression));
      return names.includes("event") ? "event" : names.includes("override") ? "override" : undefined;
    };
    for (const m of node.members) {
      if (!ts.isMethodDeclaration(m) || !ts.isIdentifier(m.name) || !m.body) continue;
      const kind = methodKind(m);
      if (kind === undefined) continue;
      const sig = this.signature(m, kind, parentType);
      if (sig) this.ownSigs.set(m.name.text, sig);
    }

    for (const m of node.members) {
      if (ts.isSemicolonClassElement(m)) continue;
      if (ts.isMethodDeclaration(m)) {
        if (methodKind(m) !== undefined) {
          const sig = ts.isIdentifier(m.name) ? this.ownSigs.get(m.name.text) : undefined;
          if (!ts.isIdentifier(m.name) || !m.body) {
            this.sink.error("ABFC2099", "an @event or @override method needs an identifier name and a body", m.name);
          } else if (sig && sig.node === m) {
            cls.events.push(this.event(m, cls, sig));
          }
        } else {
          this.sink.error("ABFC2099", `method ${m.name.getText()} is not supported (only @event and @override methods)`, m.name);
        }
        continue;
      }
      this.sink.error("ABFC2099", `class member of kind ${ts.SyntaxKind[m.kind]} is not supported`, m);
    }
    this.classes.push(cls);
  }

  /** True when the class or one of its base classes is an engine Actor (`@bpPath /Script/<Module>.Actor`). */
  private derivesFromActor(type: ts.Type): boolean {
    const seen = new Set<ts.Type>();
    const walk = (t: ts.Type): boolean => {
      if (seen.has(t)) return false;
      seen.add(t);
      const sym = t.getSymbol();
      const info = sym ? classInfo(sym) : undefined;
      if (info !== undefined && /^\/Script\/[^.]+\.Actor$/.test(info.path)) return true;
      return (t.isClassOrInterface() ? this.checker.getBaseTypes(t) : []).some(walk);
    };
    return walk(type);
  }

  /** Parameters of an owned method; for `@override` they come from the parent stub (`@bpParam`), not from the annotations. */
  private signature(m: ts.MethodDeclaration, kind: "event" | "override", parentType: ts.Type): OwnSig | undefined {
    const name = (m.name as ts.Identifier).text;
    const params: HirEvent["params"] = [];
    const paramSyms: OwnSig["paramSyms"] = [];
    for (const p of m.parameters) {
      if (!ts.isIdentifier(p.name)) {
        this.sink.error("ABFC2099", "destructured parameters are not supported", p);
        continue;
      }
      const t = this.checker.getTypeAtLocation(p);
      let type = bpTypeOf(this.checker, t);
      if (type === undefined && kind === "event") {
        if (t.flags & ts.TypeFlags.NumberLike) {
          this.sink.error("ABFC2014", `number kind of parameter ${p.name.text} is not inferable: use int, int64, byte, float or double`, p);
          type = "number";
        } else {
          this.sink.error("ABFC2099", `parameter ${p.name.text} has a type without a Blueprint equivalent`, p);
          type = "unknown";
        }
      }
      this.noteTypes(t);
      params.push({ name: p.name.text, type: type ?? "unknown" });
      paramSyms.push(this.checker.getSymbolAtLocation(p.name));
    }
    if (kind === "event") return { node: m, kind, params, paramSyms };

    const prop = this.checker.getPropertyOfType(parentType, name);
    const fi = prop ? functionInfo(prop) : undefined;
    if (!fi) {
      this.sink.error("ABFC2060", `@override ${name}: the parent class has no event or function ${name} with Blueprint metadata (@bpPath)`, m.name);
      return undefined;
    }
    if (fi.params.length !== params.length) {
      this.sink.error("ABFC2055", `@override ${name} takes ${params.length} parameter(s) but the parent declares ${fi.params.length}`, m.name);
      return undefined;
    }
    return { node: m, kind, params: fi.params.map((p) => ({ name: p.pin, type: p.type })), paramSyms, overrideOf: fi.owner };
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

  private event(m: ts.MethodDeclaration, cls: HirClass, sig: OwnSig): HirEvent {
    const name = m.name as ts.Identifier;
    this.cls = cls;
    this.body = m.body!;
    this.locals = new Map();
    this.params = new Map();
    this.holes = new Map();
    this.handled = new Set();
    this.nextLocal = 0;
    sig.paramSyms.forEach((sym, i) => {
      const p = sig.params[i];
      if (sym && p) this.params.set(sym, { name: p.name, type: p.type });
    });
    const body = this.stmts(m.body!.statements);
    const doc = docOf(m);
    return {
      name: name.text,
      kind: sig.kind,
      ...(sig.overrideOf !== undefined ? { overrideOf: sig.overrideOf } : {}),
      ...(doc !== undefined ? { doc } : {}),
      params: sig.params,
      body,
      span: this.sp(name),
    };
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
      if (node.expression) f.fail("ABFC2099", "returning a value is not supported", node);
      return { k: "return", span: this.sp(node) };
    }
    if (ts.isForOfStatement(node)) return this.forOf(node);
    if (ts.isForStatement(node)) return this.forCount(node);
    if (ts.isTryStatement(node) || ts.isThrowStatement(node)) f.fail("ABFC2020", "try/catch/throw are not supported", node);
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) f.fail("ABFC2020", "local functions and classes are not supported", node);
    return f.fail("ABFC2099", `statement of kind ${ts.SyntaxKind[node.kind]} is not supported`, node);
  }

  private constStmt(node: ts.VariableStatement): HirStmt {
    const f: DiagSink = this.sink;
    const list = node.declarationList;
    if (!(list.flags & ts.NodeFlags.Const)) f.fail("ABFC2099", "only const declarations are supported (let is only allowed as the counter of a counted for loop)", node);
    const d = list.declarations[0];
    if (list.declarations.length !== 1 || !d) f.fail("ABFC2099", "declare one const per statement", node);
    if (!ts.isIdentifier(d.name)) f.fail("ABFC2099", "destructuring is not supported", d.name);
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
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) f.fail("ABFC2099", "compound assignment is not supported", e);
    }
    if (ts.isAwaitExpression(e)) f.fail("ABFC2099", "await is not supported", e);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ARRAY_MUTATORS.has(e.expression.name.text) && this.isArrayNode(e.expression.expression)) {
      return this.arrayMutation(e, e.expression, this.sp(node));
    }
    const h = this.expr(e);
    if (h.k !== "call" && h.k !== "optional" && h.k !== "callOwn") f.fail("ABFC2099", "this expression statement has no effect", e);
    return { k: "expr", e: h, span: this.sp(node) };
  }

  private assign(e: ts.BinaryExpression): HirStmt {
    const f: DiagSink = this.sink;
    const left = e.left;
    if (ts.isPropertyAccessExpression(left) && left.name.text === "length" && this.isArrayNode(left.expression)) {
      const self = this.selfArray(left.expression);
      if (!self) return f.fail("ABFC2041", ARRAY_OWN_ONLY, left.expression);
      const r = stripParens(e.right);
      if (!ts.isNumericLiteral(r) || r.text !== "0") return f.fail("ABFC2099", "only `<array>.length = 0` is supported (it clears the array)", e.right);
      return { k: "arrayOp", op: "clear", array: self, span: this.sp(e) };
    }
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
    const right = stripParens(e.right);
    if (ts.isConditionalExpression(right)) {
      const cond = this.expr(right.condition, "bool", true);
      const a = this.expr(right.whenTrue, type);
      const b = this.expr(right.whenFalse, type);
      return { k: "setSelfCond", name, type, cond, a, b, span: this.sp(e) };
    }
    const value = this.expr(e.right, type);
    return { k: "setSelf", name, type, value, span: this.sp(e) };
  }

  /** Whether the expression has a TypeScript array type (Blueprint arrays are TypeScript arrays). */
  private isArrayNode(n: ts.Expression): boolean {
    return this.checker.isArrayType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(n)));
  }

  /** `this.<Array>` where the member is a Blueprint array variable of this class. */
  private selfArray(n: ts.Expression): { self: string; type: BpType } | undefined {
    const x = stripParens(n);
    if (!ts.isPropertyAccessExpression(x) || x.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
    const sym = this.checker.getSymbolAtLocation(x.name);
    const type = sym ? bpTypeOfMember(sym) : undefined;
    if (!sym || type === undefined || !type.startsWith("array:")) return undefined;
    return { self: splitMemberPath(bpPathOf(sym) ?? "")?.name ?? x.name.text, type };
  }

  /** `this.Arr.push(x)` and `this.Arr.splice(i, 1)` as statements. */
  private arrayMutation(call: ts.CallExpression, callee: ts.PropertyAccessExpression, span: Span): HirStmt {
    const f: DiagSink = this.sink;
    const self = this.selfArray(callee.expression);
    if (!self) return f.fail("ABFC2041", ARRAY_OWN_ONLY, callee.expression);
    const elem = self.type.slice("array:".length);
    const args = call.arguments;
    if (callee.name.text === "push") {
      if (args.length !== 1) return f.fail("ABFC2099", "push takes exactly one value", call);
      return { k: "arrayOp", op: "push", array: self, value: this.expr(args[0]!, elem), span };
    }
    const count = args[1] ? stripParens(args[1]) : undefined;
    if (args.length !== 2 || !count || !ts.isNumericLiteral(count) || count.text !== "1") {
      return f.fail("ABFC2099", "splice(index, 1) is the only supported form (the second argument must be the literal 1)", call);
    }
    const index = this.expr(args[0]!, "int");
    if (kindOfBpType(index.type) !== "int") return f.fail("ABFC2012", `an array index must be an int, not ${index.type}`, args[0]!);
    return { k: "arrayOp", op: "removeAt", array: self, index, span };
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

  /** `for (let i = A; cond; i++ | i-- | i = i + 1 | i = i - 1)` with an int counter. */
  private forCount(node: ts.ForStatement): HirStmt {
    const f: DiagSink = this.sink;
    const init = node.initializer;
    if (!init || !ts.isVariableDeclarationList(init) || !(init.flags & ts.NodeFlags.Let) || init.declarations.length !== 1) {
      return f.fail("ABFC2099", "for needs `let i = <int>` as its only initializer (counted loops); use for..of over arrays", node.initializer ?? node);
    }
    const d = init.declarations[0];
    if (!d || !ts.isIdentifier(d.name) || !d.initializer) return f.fail("ABFC2099", "the counter of a for loop needs a name and an initial value", init);
    if (!node.condition) return f.fail("ABFC2099", "a counted for loop needs a condition", node);
    if (!node.incrementor) return f.fail("ABFC2099", "a counted for loop needs a step (i++, i--, i = i + 1 or i = i - 1)", node);
    const sym = this.checker.getSymbolAtLocation(d.name);
    const initE = this.expr(d.initializer, "int");
    if (kindOfBpType(initE.type) !== "int") return f.fail("ABFC2012", `the counter of a counted for loop must be an int, not ${initE.type}`, d.initializer);
    const step = this.countStep(node.incrementor, sym);
    if (step === undefined) return f.fail("ABFC2099", "the step of a counted for loop must be i++, i--, i = i + 1 or i = i - 1 on the loop counter", node.incrementor);
    const id = this.nextLocal++;
    if (sym) this.locals.set(sym, { id, name: d.name.text, type: "int", poison: false });
    try {
      const cond = this.expr(node.condition, "bool", true);
      if (cond.type !== "bool") return f.fail("ABFC2012", `the condition of a for loop must be a boolean, not ${cond.type}`, node.condition);
      const body = this.block(node.statement);
      return { k: "forCount", counter: id, name: d.name.text, init: initE, cond, step, body, span: this.sp(node) };
    } finally {
      if (sym) this.locals.delete(sym); // the counter is not visible after the loop
    }
  }

  private countStep(inc: ts.Expression, sym: ts.Symbol | undefined): 1 | -1 | undefined {
    const isCounter = (x: ts.Expression): boolean => {
      const y = stripParens(x);
      return ts.isIdentifier(y) && sym !== undefined && this.checker.getSymbolAtLocation(y) === sym;
    };
    const x = stripParens(inc);
    if ((ts.isPostfixUnaryExpression(x) || ts.isPrefixUnaryExpression(x)) && isCounter(x.operand)) {
      if (x.operator === ts.SyntaxKind.PlusPlusToken) return 1;
      if (x.operator === ts.SyntaxKind.MinusMinusToken) return -1;
      return undefined;
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken && isCounter(x.left)) {
      const r = stripParens(x.right);
      if (ts.isBinaryExpression(r) && isCounter(r.left) && ts.isNumericLiteral(r.right) && r.right.text === "1") {
        if (r.operatorToken.kind === ts.SyntaxKind.PlusToken) return 1;
        if (r.operatorToken.kind === ts.SyntaxKind.MinusToken) return -1;
      }
    }
    return undefined;
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
    if (tsym && CONTAINERS.has(tsym.name)) this.sink.fail("ABFC2040", `${tsym.name} is not supported`, node);

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
        if (expected !== undefined && expected.startsWith("enum:")) return this.enumLit(node as ts.StringLiteral, expected);
        return this.lit(node, (node as ts.StringLiteral).text, expected !== undefined && STRINGY.has(expected) ? expected : "string");
      case ts.SyntaxKind.Identifier: {
        if (expected !== undefined && expected.startsWith("class:")) {
          const ci = this.classArg(node as ts.Identifier);
          if (ci) {
            this.classMeta[ci.path] = ci.meta;
            return { k: "classRef", path: ci.path, type: expected, span: sp };
          }
        }
        return this.identifier(node as ts.Identifier, sp);
      }
      case ts.SyntaxKind.PrefixUnaryExpression: {
        const u = node as ts.PrefixUnaryExpression;
        if (u.operator === ts.SyntaxKind.ExclamationToken) return { k: "not", e: this.expr(u.operand, "bool", inCond), type: "bool", span: sp };
        if (u.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(u.operand)) {
          return this.lit(node, -Number(u.operand.text), expected !== undefined && NUMERIC.has(expected) ? expected : "number");
        }
        return f.fail("ABFC2099", "this unary operator is not supported", node);
      }
      case ts.SyntaxKind.PropertyAccessExpression:
        return this.propAccess(node as ts.PropertyAccessExpression, sp);
      case ts.SyntaxKind.ElementAccessExpression: {
        const ea = node as ts.ElementAccessExpression;
        const array = this.expr(ea.expression);
        if (!array.type.startsWith("array:")) return f.fail("ABFC2099", "indexing is only supported on Blueprint arrays", ea.expression);
        const index = this.expr(ea.argumentExpression, "int");
        if (kindOfBpType(index.type) !== "int") return f.fail("ABFC2012", `an array index must be an int, not ${index.type}`, ea.argumentExpression);
        const elem = array.type.slice("array:".length);
        return { k: "index", array, index, elem, type: elem, span: sp };
      }
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
        return f.fail("ABFC2099", "array literals are not supported", node);
      }
      case ts.SyntaxKind.AwaitExpression:
        return f.fail("ABFC2099", "await is not supported", node);
      case ts.SyntaxKind.ConditionalExpression:
        return f.fail("ABFC2099", "the conditional operator `?:` is only supported as the whole right-hand side of this.X = c ? a : b", node);
      case ts.SyntaxKind.TemplateExpression:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.TaggedTemplateExpression:
        return f.fail("ABFC2099", "template strings are not supported", node);
      default:
        return f.fail("ABFC2099", `expression of kind ${ts.SyntaxKind[node.kind]} is not supported`, node);
    }
  }

  private enumLit(node: ts.StringLiteral, expected: BpType): HirExpr {
    const ctx = this.checker.getContextualType(node);
    if (ctx) {
      const members = ctx.isUnion() ? ctx.types : [ctx];
      const known = members.filter((m): m is ts.StringLiteralType => m.isStringLiteral()).map((m) => m.value);
      if (known.length > 0 && !known.includes(node.text)) {
        this.sink.fail("ABFC2015", `"${node.text}" is not a value of ${expected.slice("enum:".length)} (${known.join(", ")})`, node);
      }
    }
    return { k: "enumLit", text: node.text, enumPath: expected.slice("enum:".length), type: expected, span: this.sp(node) };
  }

  /** The owned method a `this.<Name>` expression names, if any. */
  private ownMethodOf(node: ts.PropertyAccessExpression): OwnSig | undefined {
    if (node.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
    const own = this.ownSigs.get(node.name.text);
    if (!own) return undefined;
    const sym = this.checker.getSymbolAtLocation(node.name);
    return sym === undefined || (sym.declarations ?? []).includes(own.node) ? own : undefined;
  }

  /** A delegate argument: a reference to an owned `@event` method. */
  private delegateArg(arg: ts.Expression): HirExpr {
    let x = arg;
    while (ts.isParenthesizedExpression(x)) x = x.expression;
    const own = ts.isPropertyAccessExpression(x) ? this.ownMethodOf(x) : undefined;
    if (!ts.isPropertyAccessExpression(x) || !own || own.kind !== "event") {
      return this.sink.fail("ABFC2054", "a delegate argument must be a reference to an own @event method (this.<Name>)", arg);
    }
    return { k: "delegateRef", event: x.name.text, type: "delegate", span: this.sp(arg) };
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
    return this.sink.fail("ABFC2099", `identifier "${node.text}" cannot be used as a value`, node);
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
      if (this.ownMethodOf(node)) return f.fail("ABFC2054", "method references are only allowed as delegate arguments", node);
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
      if (rt === "nameOf") {
        const a0 = node.arguments[0];
        if (node.arguments.length !== 1 || !a0 || !(ts.isStringLiteral(a0) || ts.isNoSubstitutionTemplateLiteral(a0))) {
          return f.fail("ABFC2099", "nameOf(text) takes one string literal", node);
        }
        return { k: "nameLit", text: a0.text, type: "name", span: sp };
      }
      if (rt === "createWidget") return this.createWidgetExpr(node, sp);
      if (rt === "spawnActor") return this.spawnExpr(node, sp);
      if (callee.text === "eval") return f.fail("ABFC2020", "eval is not supported", node);
      return f.fail("ABFC2099", `call of "${callee.text}" is not supported`, node);
    }
    if (!ts.isPropertyAccessExpression(callee)) return f.fail("ABFC2099", "only method and library calls are supported", node);

    if (this.isArrayNode(callee.expression)) {
      const m = callee.name.text;
      if (m === "indexOf") {
        if (node.arguments.length !== 1) return f.fail("ABFC2099", "indexOf(value) takes one argument", node);
        const array = this.expr(callee.expression);
        if (!array.type.startsWith("array:")) return f.fail("ABFC2099", "indexOf is only supported on Blueprint arrays", callee.expression);
        const elem = array.type.slice("array:".length);
        return { k: "arrayFind", array, value: this.expr(node.arguments[0]!, elem), elem, type: "int", span: sp };
      }
      if (ARRAY_MUTATORS.has(m)) return f.fail("ABFC2041", ARRAY_OWN_ONLY, node);
    }

    const own = this.ownMethodOf(callee);
    if (own) {
      const ownArgs: Array<{ pin: string; value: HirExpr }> = [];
      node.arguments.forEach((a) => {
        const p = own.params[ownArgs.length];
        if (!p) f.fail("ABFC2099", `too many arguments for ${callee.name.text}`, a);
        ownArgs.push({ pin: p.name, value: this.expr(a, p.type) });
      });
      return { k: "callOwn", name: callee.name.text, args: ownArgs, type: "void", span: sp };
    }

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
      args.push({ pin: p.pin, value: p.type === "unsupported:delegate" ? this.delegateArg(a) : this.expr(a, p.type) });
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

  private createWidgetExpr(node: ts.CallExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    if (node.arguments.length !== 2) return f.fail("ABFC2099", "createWidget(Class, owningPlayer) takes two arguments", node);
    const ci = this.classArg(node.arguments[0]);
    if (!ci) return f.fail("ABFC2060", "the widget class has no Blueprint metadata (@bpPath)", node.arguments[0] ?? node);
    this.classMeta[ci.path] = ci.meta;
    const owner = this.expr(node.arguments[1]!);
    return { k: "createWidget", cls: ci.path, owner, type: `object:${ci.path}`, span: sp };
  }

  private spawnExpr(node: ts.CallExpression, sp: Span): HirExpr {
    const f: DiagSink = this.sink;
    const [clsArg, optsArg] = node.arguments;
    if (!clsArg || node.arguments.length > 2) return f.fail("ABFC2099", "spawnActor(Class, options?) takes a class and an optional options object", node);
    const ci = this.classArg(clsArg);
    if (!ci) return f.fail("ABFC2060", "the spawned class has no Blueprint metadata (@bpPath)", clsArg);
    this.classMeta[ci.path] = ci.meta;
    let owner: HirExpr | undefined;
    let collision: string | undefined;
    let scale: string | undefined;
    if (optsArg) {
      if (!ts.isObjectLiteralExpression(optsArg)) return f.fail("ABFC2056", "spawnActor options must be an object literal", optsArg);
      for (const p of optsArg.properties) {
        const key = ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
        if (!ts.isPropertyAssignment(p) || key === undefined) return f.fail("ABFC2056", "spawnActor options must be plain key: value entries", p);
        const init = p.initializer;
        const text = ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init.text : undefined;
        if (key === "owner") owner = this.expr(init);
        else if (key === "collisionHandlingOverride" || key === "transformScaleMethod") {
          if (text === undefined) return f.fail("ABFC2056", `spawnActor option ${key} must be a string literal (the enum text)`, init);
          if (key === "collisionHandlingOverride") collision = text;
          else scale = text;
        } else if (key === "instigator") return f.fail("ABFC2056", "spawnActor option instigator is not supported yet", p);
        else return f.fail("ABFC2056", `unknown spawnActor option "${key}" (owner, collisionHandlingOverride, transformScaleMethod)`, p.name);
      }
    }
    return {
      k: "spawn",
      cls: ci.path,
      ...(owner ? { owner } : {}),
      ...(collision !== undefined ? { collision } : {}),
      ...(scale !== undefined ? { scale } : {}),
      type: `object:${ci.path}`,
      span: sp,
    };
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
        if (!inCond) f.fail("ABFC2099", "`&&` and `||` are only supported inside if conditions", node);
        const a = this.expr(node.left, "bool", true);
        const b = this.expr(node.right, "bool", true);
        return op === ts.SyntaxKind.AmpersandAmpersandToken ? { k: "and", a, b, type: "bool", span: sp } : { k: "or", a, b, type: "bool", span: sp };
      }
      case ts.SyntaxKind.PlusToken:
        return this.arithExpr(node, "+", sp);
      case ts.SyntaxKind.MinusToken:
        return this.arithExpr(node, "-", sp);
      case ts.SyntaxKind.AsteriskToken:
        return this.arithExpr(node, "*", sp);
      case ts.SyntaxKind.LessThanToken:
        return this.cmpExpr(node, "<", sp);
      case ts.SyntaxKind.LessThanEqualsToken:
        return this.cmpExpr(node, "<=", sp);
      case ts.SyntaxKind.GreaterThanToken:
        return this.cmpExpr(node, ">", sp);
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return this.cmpExpr(node, ">=", sp);
      case ts.SyntaxKind.SlashToken: {
        const kinds = [node.left, node.right].map((x) => {
          const t = bpTypeOf(this.checker, this.checker.getTypeAtLocation(x));
          return t === undefined ? undefined : kindOfBpType(t);
        });
        if (kinds.includes("int") || kinds.includes("byte")) f.fail("ABFC2010", "`/` on integer values is not supported; use idiv(a, b)", node);
        return f.fail("ABFC2099", "`/` on real values is not supported", node);
      }
      default:
        return f.fail("ABFC2099", `operator ${node.operatorToken.getText()} is not supported`, node.operatorToken);
    }
  }

  /** Both operands of `+ - * < <= > >=`: same numeric kind (int or real); literals take the other side's type. */
  private numericOperands(node: ts.BinaryExpression): { a: HirExpr; b: HirExpr; kind: "int" | "real" } {
    const f: DiagSink = this.sink;
    const strip = (x: ts.Expression): ts.Expression => {
      let y = x;
      while (ts.isParenthesizedExpression(y)) y = y.expression;
      return y;
    };
    const l = strip(node.left);
    const r = strip(node.right);
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
    if (ka === undefined && kb === undefined) return f.fail("ABFC2014", "the number kind of this expression is not inferable; use int, int64, byte, float or double values", node);
    if (ka !== undefined && kb !== undefined && ka !== kb) return f.fail("ABFC2012", `cannot combine ${a.type} with ${b.type}: operands need the same number kind (int or real)`, node);
    const kind = (ka ?? kb)!;
    if (kind !== "int" && kind !== "real") return f.fail("ABFC2012", `${node.operatorToken.getText()} needs int or real operands, not ${a.type}`, node);
    return { a, b, kind };
  }

  private arithExpr(node: ts.BinaryExpression, op: "+" | "-" | "*", sp: Span): HirExpr {
    const { a, b, kind } = this.numericOperands(node);
    return { k: "arith", op, kind, a, b, type: kind === "int" ? "int" : "double", span: sp };
  }

  private cmpExpr(node: ts.BinaryExpression, op: "<" | "<=" | ">" | ">=", sp: Span): HirExpr {
    const { a, b, kind } = this.numericOperands(node);
    return { k: "cmp", op, kind, a, b, type: "bool", span: sp };
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
