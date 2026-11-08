import type { TSESTree } from "@typescript-eslint/utils";
import {
  AUTHORITY_CALLS,
  TICK_METHODS,
  createRule,
  enclosingMethod,
  isAuthorityGuarded,
  isServerRpcMethod,
  netTagsOf,
  tickMethodOf,
  typedServices,
} from "../util.js";

type Options = [{ authorityCalls?: string[]; tickMethods?: string[] }?];
type MessageIds = "clientFromClient" | "reliableSpam";

const LOOPS = new Set<string>([
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

/** Whether `node` is inside a loop statement of its own method (a callback boundary ends the search). */
function inLoop(node: TSESTree.Node): boolean {
  for (let cur: TSESTree.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (LOOPS.has(cur.type)) return true;
    if (
      cur.type === "FunctionDeclaration" ||
      cur.type === "FunctionExpression" ||
      cur.type === "ArrowFunctionExpression"
    ) {
      return false;
    }
  }
  return false;
}

/** Name of a private method (`private H` or `#H`), or null for any other method. */
function privateMethodName(m: TSESTree.MethodDefinition): string | null {
  if (m.key.type === "PrivateIdentifier") return "#" + m.key.name;
  if (m.accessibility === "private" && !m.computed && m.key.type === "Identifier") return m.key.name;
  return null;
}

/** `this.H` -> "H", `this.#H` -> "#H", anything else -> null. */
function thisMethodRef(n: TSESTree.Node): string | null {
  if (n.type !== "MemberExpression" || n.computed || n.object.type !== "ThisExpression") return null;
  if (n.property.type === "Identifier") return n.property.name;
  if (n.property.type === "PrivateIdentifier") return "#" + n.property.name;
  return null;
}

/**
 * The methods of a class body whose `this.Notify()`-style calls run on the server: server RPC methods, plus private
 * methods whose every call site lies directly in such a method (a fixpoint). A private method that is referenced
 * without being called (passed as a callback) is never added.
 */
function serverContextOf(
  body: TSESTree.ClassBody,
  services: NonNullable<ReturnType<typeof typedServices>>,
  visitorKeys: Readonly<Record<string, readonly string[] | undefined>>,
): Set<TSESTree.MethodDefinition> {
  const methods = body.body.filter((m): m is TSESTree.MethodDefinition => m.type === "MethodDefinition");
  const serverRpc = new Set<TSESTree.MethodDefinition>(methods.filter((m) => isServerRpcMethod(services, m)));
  const privates = new Map<string, TSESTree.MethodDefinition>();
  for (const m of methods) {
    const name = privateMethodName(m);
    if (name !== null) privates.set(name, m);
  }
  if (privates.size === 0) return serverRpc;

  const sites = new Map<string, (TSESTree.MethodDefinition | null)[]>();
  const escaped = new Set<string>();
  const walk = (n: TSESTree.Node): void => {
    if (n !== body && n.type === "ClassBody") return;
    const ref = thisMethodRef(n);
    if (ref !== null && privates.has(ref)) {
      const p = n.parent;
      if (p?.type === "CallExpression" && p.callee === n) {
        const list = sites.get(ref) ?? [];
        list.push(enclosingMethod(p));
        sites.set(ref, list);
      } else {
        escaped.add(ref);
      }
    }
    for (const key of visitorKeys[n.type] ?? []) {
      const child = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof (c as TSESTree.Node).type === "string") walk(c as TSESTree.Node);
      } else if (child && typeof (child as TSESTree.Node).type === "string") {
        walk(child as TSESTree.Node);
      }
    }
  };
  walk(body);

  const candidates = new Map<TSESTree.MethodDefinition, string>();
  for (const [name, m] of privates) {
    if (sites.has(name) && !escaped.has(name)) candidates.set(m, name);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [m, name] of candidates) {
      const ok = (sites.get(name) ?? []).every((s) => s !== null && (serverRpc.has(s) || candidates.has(s)));
      if (!ok) {
        candidates.delete(m);
        changed = true;
      }
    }
  }
  return new Set<TSESTree.MethodDefinition>([...serverRpc, ...candidates.keys()]);
}

export default createRule<Options, MessageIds>({
  name: "rpc-misuse",
  meta: {
    type: "problem",
    docs: { description: "Disallow sending client/multicast RPCs without authority and reliable RPCs every frame." },
    messages: {
      clientFromClient: "{{name}} is a {{kind}} RPC; only the server can send it (guard with HasAuthority())",
      reliableSpam: "reliable RPC {{name}} is sent every frame or in a loop; make it unreliable or send it less often",
    },
    schema: [
      {
        type: "object",
        properties: {
          authorityCalls: { type: "array", items: { type: "string" } },
          tickMethods: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const services = typedServices(context);
    if (!services) return {};
    const authorityCalls = options?.authorityCalls ?? AUTHORITY_CALLS;
    const tickMethods = options?.tickMethods ?? TICK_METHODS;
    const visitorKeys = context.sourceCode.visitorKeys as Readonly<Record<string, readonly string[] | undefined>>;
    const stack: Set<TSESTree.MethodDefinition>[] = [];
    return {
      ClassBody(node) {
        stack.push(serverContextOf(node, services, visitorKeys));
      },
      "ClassBody:exit"() {
        stack.pop();
      },
      CallExpression(node) {
        const callee = node.callee;
        let nameNode: TSESTree.Node | null = null;
        let name: string | null = null;
        if (callee.type === "Identifier") {
          nameNode = callee;
          name = callee.name;
        } else if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
          nameNode = callee.property;
          name = callee.property.name;
        }
        if (!nameNode || name === null) return;
        const tags = netTagsOf(services, nameNode);
        if (tags.rpc === null) return;
        const method = enclosingMethod(node);
        const onServer = method !== null && (stack[stack.length - 1]?.has(method) ?? false);
        if (
          (tags.rpc === "client" || tags.rpc === "multicast") &&
          !onServer &&
          !isAuthorityGuarded(node, authorityCalls)
        ) {
          context.report({ node, messageId: "clientFromClient", data: { name, kind: tags.rpc } });
        }
        if (tags.reliable && (tickMethodOf(node, tickMethods) !== null || inLoop(node))) {
          context.report({ node, messageId: "reliableSpam", data: { name } });
        }
      },
    };
  },
});
