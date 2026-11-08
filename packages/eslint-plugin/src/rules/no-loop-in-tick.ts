import type { TSESTree } from "@typescript-eslint/utils";
import { TICK_METHODS, createRule, keyName, tickMethodOf } from "../util.js";

type Options = [{ tickMethods?: string[] }?];
type MessageIds = "loop";

export default createRule<Options, MessageIds>({
  name: "no-loop-in-tick",
  meta: {
    type: "problem",
    docs: { description: "Disallow loops in a tick event." },
    messages: {
      loop: "a loop in {{tick}} runs every frame; move it to a timer or an event",
    },
    schema: [
      {
        type: "object",
        properties: {
          tickMethods: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const tickMethods = options?.tickMethods ?? TICK_METHODS;
    const check = (node: TSESTree.Node): void => {
      const tick = tickMethodOf(node, tickMethods);
      if (!tick) return;
      context.report({ node, messageId: "loop", data: { tick: keyName(tick.key, tick.computed) ?? "a tick event" } });
    };
    return {
      ForStatement: check,
      ForOfStatement: check,
      ForInStatement: check,
      WhileStatement: check,
      DoWhileStatement: check,
      "CallExpression[callee.type='MemberExpression'][callee.property.name='forEach']": check,
    };
  },
});
