import noHeavyCallInTick from "./rules/no-heavy-call-in-tick.js";
import noLoopInTick from "./rules/no-loop-in-tick.js";
import noUnboundedArrayGrowth from "./rules/no-unbounded-array-growth.js";
import replicatedWriteNeedsAuthority from "./rules/replicated-write-needs-authority.js";
import rpcMisuse from "./rules/rpc-misuse.js";

const rules = {
  "no-heavy-call-in-tick": noHeavyCallInTick,
  "no-loop-in-tick": noLoopInTick,
  "replicated-write-needs-authority": replicatedWriteNeedsAuthority,
  "rpc-misuse": rpcMisuse,
  "no-unbounded-array-growth": noUnboundedArrayGrowth,
};

const plugin = {
  meta: { name: "@abfc/eslint-plugin", version: "0.1.0" },
  rules,
  configs: {} as { recommended: { plugins: { abfc: unknown }; rules: Record<string, "warn"> } },
};

plugin.configs.recommended = {
  plugins: { abfc: plugin },
  rules: Object.fromEntries(Object.keys(rules).map((name) => [`abfc/${name}`, "warn" as const])),
};

export default plugin;
