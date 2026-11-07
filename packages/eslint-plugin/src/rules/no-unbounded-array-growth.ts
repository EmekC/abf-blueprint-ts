import type { TSESTree } from "@typescript-eslint/utils";
import { createRule, overrideMethodOf, thisMemberName } from "../util.js";

type Options = [{ ignore?: string[]; oneTimeMethods?: string[] }?];
type MessageIds = "grows";

/** Overrides the engine calls once per object; a push there fills the array once. */
const ONE_TIME_METHODS: readonly string[] = ["ReceiveBeginPlay", "Construct", "OnInitialized"];

/** Array methods that remove entries. */
const REMOVERS: readonly string[] = ["splice", "pop", "shift"];

interface ClassState {
  pushes: { node: TSESTree.CallExpression; name: string }[];
  /** Arrays the class empties, shrinks or replaces somewhere. */
  bounded: Set<string>;
}

export default createRule<Options, MessageIds>({
  name: "no-unbounded-array-growth",
  meta: {
    type: "suggestion",
    docs: { description: "Disallow pushing to an array field that the class never shrinks or bounds." },
    messages: {
      grows: "{{name}} only grows; clear it, remove entries, or bound it with a length check",
    },
    schema: [
      {
        type: "object",
        properties: {
          ignore: { type: "array", items: { type: "string" } },
          oneTimeMethods: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const ignore = options?.ignore ?? [];
    const oneTime = options?.oneTimeMethods ?? ONE_TIME_METHODS;
    const sourceCode = context.sourceCode;
    const stack: ClassState[] = [];

    /** Whether an enclosing condition of the push mentions the array's length or a membership test. */
    const boundedByTest = (push: TSESTree.Node, name: string): boolean => {
      const needles = [`this.${name}.length`, `this.${name}.includes(`, `this.${name}.indexOf(`];
      let child: TSESTree.Node = push;
      for (let cur: TSESTree.Node | undefined = push.parent; cur && cur.type !== "ClassBody"; cur = cur.parent) {
        let test: TSESTree.Node | null = null;
        if (cur.type === "IfStatement" || cur.type === "ConditionalExpression") test = cur.test;
        else if (cur.type === "WhileStatement" || cur.type === "ForStatement") test = cur.test;
        if (test && test !== child) {
          const text = sourceCode.getText(test);
          if (needles.some((n) => text.includes(n))) return true;
        }
        child = cur;
      }
      return false;
    };

    return {
      ClassBody() {
        stack.push({ pushes: [], bounded: new Set() });
      },
      "ClassBody:exit"() {
        const state = stack.pop();
        if (!state) return;
        for (const p of state.pushes) {
          if (state.bounded.has(p.name) || ignore.includes(p.name) || boundedByTest(p.node, p.name)) continue;
          context.report({ node: p.node, messageId: "grows", data: { name: p.name } });
        }
      },
      CallExpression(node) {
        const state = stack[stack.length - 1];
        const callee = node.callee;
        if (!state || callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") {
          return;
        }
        const name = thisMemberName(callee.object);
        if (name === null) return;
        const method = callee.property.name;
        if (method === "push") {
          if (overrideMethodOf(node, oneTime) === null) state.pushes.push({ node, name });
        }
        else if (REMOVERS.includes(method)) state.bounded.add(name);
      },
      AssignmentExpression(node) {
        const state = stack[stack.length - 1];
        if (!state) return;
        // this.A = ... (replaced) and this.A.length = ... (truncated)
        const direct = thisMemberName(node.left);
        if (direct !== null) {
          state.bounded.add(direct);
          return;
        }
        const left = node.left;
        if (
          left.type === "MemberExpression" &&
          !left.computed &&
          left.property.type === "Identifier" &&
          left.property.name === "length"
        ) {
          const name = thisMemberName(left.object);
          if (name !== null) state.bounded.add(name);
        }
      },
    };
  },
});
