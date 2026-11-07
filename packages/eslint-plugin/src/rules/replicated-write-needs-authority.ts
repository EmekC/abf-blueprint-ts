import type { TSESTree } from "@typescript-eslint/utils";
import { AUTHORITY_CALLS, createRule, isAuthorityGuarded, netTagsOf, typedServices } from "../util.js";

type Options = [{ authorityCalls?: string[] }?];
type MessageIds = "authority";

/** Array methods that change the array in place. */
const MUTATORS: readonly string[] = ["push", "splice", "pop", "shift", "unshift"];

function isConstructor(node: TSESTree.Node): boolean {
  for (let cur: TSESTree.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (cur.type === "MethodDefinition") return cur.kind === "constructor";
    if (cur.type === "ClassBody") return false;
  }
  return false;
}

/** `this.X` -> its property identifier, or null. */
function thisProperty(e: TSESTree.Node): TSESTree.Identifier | null {
  if (e.type !== "MemberExpression" || e.computed || e.object.type !== "ThisExpression") return null;
  return e.property.type === "Identifier" ? e.property : null;
}

export default createRule<Options, MessageIds>({
  name: "replicated-write-needs-authority",
  meta: {
    type: "problem",
    docs: { description: "Disallow writing a replicated variable outside an authority check." },
    messages: {
      authority: "{{name}} is replicated; write it on the server only (guard with HasAuthority())",
    },
    schema: [
      {
        type: "object",
        properties: {
          authorityCalls: { type: "array", items: { type: "string" } },
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

    const checkWrite = (report: TSESTree.Node, prop: TSESTree.Identifier | null): void => {
      if (!prop || !netTagsOf(services, prop).replicated) return;
      if (isConstructor(report) || isAuthorityGuarded(report, authorityCalls)) return;
      context.report({ node: report, messageId: "authority", data: { name: prop.name } });
    };

    return {
      AssignmentExpression(node) {
        const left = node.left;
        // this.X = ... and this.X.length = 0
        const direct = thisProperty(left);
        if (direct) return checkWrite(node, direct);
        if (
          left.type === "MemberExpression" &&
          !left.computed &&
          left.property.type === "Identifier" &&
          left.property.name === "length"
        ) {
          checkWrite(node, thisProperty(left.object));
        }
      },
      UpdateExpression(node) {
        checkWrite(node, thisProperty(node.argument));
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return;
        if (!MUTATORS.includes(callee.property.name)) return;
        checkWrite(node, thisProperty(callee.object));
      },
    };
  },
});
