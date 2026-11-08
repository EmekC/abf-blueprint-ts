import { ESLintUtils } from "@typescript-eslint/utils";
import type { ParserServicesWithTypeInformation, TSESLint } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";

export const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/lint-rules.md#${name}`,
);

export const AUTHORITY_CALLS: readonly string[] = ["HasAuthority", "IsServer", "IsDedicatedServer"];

export const HEAVY_CALLS: readonly string[] = [
  "GetAllActorsOfClass",
  "GetAllActorsOfClassWithTag",
  "GetAllActorsWithTag",
  "GetAllActorsWithInterface",
  "GetActorOfClass",
  "GetAllWidgetsOfClass",
  "GetAllWidgetsWithInterface",
  "createWidget",
  "spawnActor",
];

export const TICK_METHODS: readonly string[] = ["ReceiveTick", "Tick"];

type Node = TSESTree.Node;

/** Name of a class member key (`ReceiveTick`, `"Tick"`), or null for computed and private keys. */
export function keyName(key: TSESTree.PropertyName | TSESTree.PrivateIdentifier, computed: boolean): string | null {
  if (key.type === "Identifier") return computed ? null : key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return null;
}

function isOverrideDecorator(d: TSESTree.Decorator): boolean {
  const e = d.expression;
  return e.type === "Identifier" && e.name === "override";
}

/**
 * The method `node` runs in: the nearest enclosing MethodDefinition, not crossing a function or arrow boundary, that
 * is decorated `@override` and whose name is in `names`.
 */
export function overrideMethodOf(node: Node, names: readonly string[]): TSESTree.MethodDefinition | null {
  let cur: Node | undefined = node.parent;
  while (cur) {
    if (cur.type === "ArrowFunctionExpression" || cur.type === "FunctionDeclaration") return null;
    if (cur.type === "FunctionExpression") {
      const m = cur.parent;
      if (m?.type !== "MethodDefinition" || m.value !== cur) return null;
      const name = keyName(m.key, m.computed);
      if (name === null || !names.includes(name)) return null;
      return m.decorators.some(isOverrideDecorator) ? m : null;
    }
    cur = cur.parent;
  }
  return null;
}

/** The method `node` runs in every frame (see {@link overrideMethodOf}). */
export function tickMethodOf(node: Node, tickMethods: readonly string[]): TSESTree.MethodDefinition | null {
  return overrideMethodOf(node, tickMethods);
}

/**
 * The method whose body directly contains `node`: the nearest enclosing MethodDefinition. Null when an arrow
 * function, a function declaration or a function expression that is not a method body is crossed first.
 */
export function enclosingMethod(node: Node): TSESTree.MethodDefinition | null {
  let cur: Node | undefined = node.parent;
  while (cur) {
    if (cur.type === "ArrowFunctionExpression" || cur.type === "FunctionDeclaration") return null;
    if (cur.type === "FunctionExpression") {
      const m = cur.parent;
      return m?.type === "MethodDefinition" && m.value === cur ? m : null;
    }
    cur = cur.parent;
  }
  return null;
}

/** `foo()` -> "foo", `a.b.foo()` -> "foo" (also through `?.`), anything else -> null. */
export function calleeName(call: TSESTree.CallExpression): string | null {
  const c = call.callee;
  if (c.type === "Identifier") return c.name;
  if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier") return c.property.name;
  return null;
}

function unwrap(e: TSESTree.Node): TSESTree.Node {
  let cur = e;
  for (;;) {
    if (cur.type === "ChainExpression") cur = cur.expression;
    else if (cur.type === "TSNonNullExpression") cur = cur.expression;
    else if (cur.type === "TSAsExpression") cur = cur.expression;
    else return cur;
  }
}

/** Whether `test` being truthy (or falsy) proves that the code runs with authority. */
function implies(test: Node, truthy: boolean, authorityCalls: readonly string[]): boolean {
  const e = unwrap(test);
  if (e.type === "CallExpression") {
    const name = calleeName(e);
    return truthy && name !== null && authorityCalls.includes(name);
  }
  if (e.type === "UnaryExpression" && e.operator === "!") return implies(e.argument, !truthy, authorityCalls);
  if (e.type === "LogicalExpression") {
    if (e.operator === "&&") {
      return truthy
        ? implies(e.left, true, authorityCalls) || implies(e.right, true, authorityCalls)
        : implies(e.left, false, authorityCalls) && implies(e.right, false, authorityCalls);
    }
    if (e.operator === "||") {
      return truthy
        ? implies(e.left, true, authorityCalls) && implies(e.right, true, authorityCalls)
        : implies(e.left, false, authorityCalls) || implies(e.right, false, authorityCalls);
    }
  }
  return false;
}

function onlyReturns(s: TSESTree.Statement): boolean {
  if (s.type === "ReturnStatement") return true;
  return s.type === "BlockStatement" && s.body.length > 0 && s.body.every((b) => b.type === "ReturnStatement");
}

function isFunctionBoundary(n: Node): boolean {
  if (n.type === "FunctionDeclaration") return true;
  return n.type === "FunctionExpression" && n.parent?.type === "MethodDefinition";
}

/**
 * Whether `node` only runs with authority: it is inside the authority branch of an `if` / `?:` / `&&` up to the
 * enclosing method, or an earlier statement of an enclosing block is `if (!<authority call>) return;`.
 */
export function isAuthorityGuarded(node: Node, authorityCalls: readonly string[]): boolean {
  let child: Node = node;
  let cur: Node | undefined = node.parent;
  while (cur) {
    if (cur.type === "IfStatement" || cur.type === "ConditionalExpression") {
      if (cur.consequent === child && implies(cur.test, true, authorityCalls)) return true;
      if (cur.alternate === child && implies(cur.test, false, authorityCalls)) return true;
    } else if (cur.type === "LogicalExpression" && cur.operator === "&&") {
      if (cur.right === child && implies(cur.left, true, authorityCalls)) return true;
    } else if (cur.type === "BlockStatement" || cur.type === "SwitchCase") {
      const list: TSESTree.Node[] = cur.type === "BlockStatement" ? cur.body : cur.consequent;
      for (const s of list) {
        if (s === child) break;
        if (
          s.type === "IfStatement" &&
          s.alternate === null &&
          implies(s.test, false, authorityCalls) &&
          onlyReturns(s.consequent)
        ) {
          return true;
        }
      }
    }
    if (isFunctionBoundary(cur)) return false;
    child = cur;
    cur = cur.parent;
  }
  return false;
}

/** Replication and RPC facts the stubs carry as JSDoc tags on a hand-made member. */
export interface NetTags {
  replicated: boolean;
  /** The `@bpRpc` kind (`server`, `client`, `multicast`), or null when the member is not an RPC. */
  rpc: string | null;
  reliable: boolean;
}

const NO_TAGS: NetTags = { replicated: false, rpc: null, reliable: false };

type Checker = ReturnType<ParserServicesWithTypeInformation["program"]["getTypeChecker"]>;
type TsSymbol = NonNullable<ReturnType<Checker["getSymbolAtLocation"]>>;

/** The `@bpReplicated` / `@bpRpc` / `@bpReliable` tags of a member symbol. */
export function netTagsOfSymbol(checker: Checker, symbol: TsSymbol): NetTags {
  const tags = symbol.getJsDocTags(checker);
  if (tags.length === 0) return NO_TAGS;
  let replicated = false;
  let rpc: string | null = null;
  let reliable = false;
  for (const t of tags) {
    if (t.name === "bpReplicated") replicated = true;
    else if (t.name === "bpReliable") reliable = true;
    else if (t.name === "bpRpc") {
      const text = (t.text ?? []).map((p) => p.text).join("").trim().split(/\s+/)[0];
      rpc = text ? text.toLowerCase() : null;
    }
  }
  return { replicated, rpc, reliable };
}

/** The `@bpReplicated` / `@bpRpc` / `@bpReliable` tags of the member `node` refers to (no tags when unresolved). */
export function netTagsOf(services: ParserServicesWithTypeInformation, node: Node): NetTags {
  const symbol = services.getSymbolAtLocation(node);
  if (!symbol) return NO_TAGS;
  return netTagsOfSymbol(services.program.getTypeChecker(), symbol);
}

/**
 * Whether `m` is a server RPC: its own symbol carries `@bpRpc server`, or the member of the nearest base type it
 * overrides does.
 */
export function isServerRpcMethod(services: ParserServicesWithTypeInformation, m: TSESTree.MethodDefinition): boolean {
  if (netTagsOf(services, m.key).rpc === "server") return true;
  const name = keyName(m.key, m.computed);
  if (name === null) return false;
  const classNode = m.parent.parent;
  if (classNode.type !== "ClassDeclaration" && classNode.type !== "ClassExpression") return false;
  const tsNode = services.esTreeNodeToTSNodeMap.get(classNode);
  if (!tsNode.name) return false;
  const checker = services.program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(tsNode.name);
  if (!symbol) return false;
  const declared = checker.getDeclaredTypeOfSymbol(symbol);
  if (!declared.isClassOrInterface()) return false;
  const visited = new Set<unknown>([declared]);
  let level = checker.getBaseTypes(declared);
  for (let depth = 0; depth < 10 && level.length > 0; depth++) {
    const next: typeof level = [];
    for (const base of level) {
      if (visited.has(base)) continue;
      visited.add(base);
      const prop = base.getProperty(name);
      if (prop) return netTagsOfSymbol(checker, prop).rpc === "server";
      if (base.isClassOrInterface()) next.push(...checker.getBaseTypes(base));
    }
    level = next;
  }
  return false;
}

/** The type-aware parser services, or null when the file is linted without type information. */
export function typedServices(
  context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>,
): ParserServicesWithTypeInformation | null {
  const services = ESLintUtils.getParserServices(context, true);
  return services.program === null ? null : (services as ParserServicesWithTypeInformation);
}

/** `this.X` -> "X" (non-computed property of `this`), anything else -> null. */
export function thisMemberName(e: TSESTree.Node): string | null {
  const x = e.type === "ChainExpression" ? e.expression : e;
  if (x.type !== "MemberExpression" || x.computed || x.object.type !== "ThisExpression") return null;
  return x.property.type === "Identifier" ? x.property.name : null;
}
