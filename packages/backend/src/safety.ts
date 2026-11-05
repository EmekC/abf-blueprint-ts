import { AbfcError } from "@abfc/env";

/** The only backend tools abfc ever calls. Anything else (explicitly `bp_publish`) is refused before a message is sent. */
export const ALLOWED_TOOLS = [
  "backend_info",
  "abfc_extensions",
  "reflect",
  "staging_sync",
  "staging_status",
  "bp_apply",
  "bp_read",
  "bp_compile_report",
  "bp_game_test",
  "mod_audit",
] as const;

export type AllowedTool = (typeof ALLOWED_TOOLS)[number];

export function isAllowedTool(name: string): name is AllowedTool {
  return (ALLOWED_TOOLS as readonly string[]).includes(name);
}

/** Throws ABFC4090 (exit 3) for a tool outside {@link ALLOWED_TOOLS}. */
export function assertToolAllowed(name: string): asserts name is AllowedTool {
  if (isAllowedTool(name)) return;
  const message =
    name === "bp_publish"
      ? "publishing is not allowed in Phase 1: abfc never calls bp_publish."
      : `the backend tool "${name}" is not on abfc's allowlist and was not called.`;
  throw new AbfcError(
    {
      severity: "error",
      code: "ABFC4090",
      message,
      tried: [{ source: "allowlist", detail: ALLOWED_TOOLS.join(", ") }],
      fix: name === "bp_publish" ? "publish from the MCP client or the Mod Editor yourself." : "use one of the allowed tools.",
    },
    3,
  );
}
