import type { TSESTree } from "@typescript-eslint/utils";
import {
  AUTHORITY_CALLS,
  TICK_METHODS,
  createRule,
  isAuthorityGuarded,
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
    return {
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
        if ((tags.rpc === "client" || tags.rpc === "multicast") && !isAuthorityGuarded(node, authorityCalls)) {
          context.report({ node, messageId: "clientFromClient", data: { name, kind: tags.rpc } });
        }
        if (tags.reliable && (tickMethodOf(node, tickMethods) !== null || inLoop(node))) {
          context.report({ node, messageId: "reliableSpam", data: { name } });
        }
      },
    };
  },
});
