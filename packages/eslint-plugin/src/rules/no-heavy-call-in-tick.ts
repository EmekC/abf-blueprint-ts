import { HEAVY_CALLS, TICK_METHODS, calleeName, createRule, keyName, tickMethodOf } from "../util.js";

type Options = [{ tickMethods?: string[]; extra?: string[] }?];
type MessageIds = "heavy";

export default createRule<Options, MessageIds>({
  name: "no-heavy-call-in-tick",
  meta: {
    type: "problem",
    docs: { description: "Disallow expensive world queries and spawns in a tick event." },
    messages: {
      heavy: "`{{name}}` runs every frame in {{tick}}; cache the result (on BeginPlay, a timer or an event)",
    },
    schema: [
      {
        type: "object",
        properties: {
          tickMethods: { type: "array", items: { type: "string" } },
          extra: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const tickMethods = options?.tickMethods ?? TICK_METHODS;
    const heavy = [...HEAVY_CALLS, ...(options?.extra ?? [])];
    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (name === null || !heavy.includes(name)) return;
        const tick = tickMethodOf(node, tickMethods);
        if (!tick) return;
        context.report({
          node,
          messageId: "heavy",
          data: { name, tick: keyName(tick.key, tick.computed) ?? "a tick event" },
        });
      },
    };
  },
});
