import type { CliContext } from "../context.js";
import { BackendSession, Recorder } from "./common.js";
import { runBuild } from "./build.js";
import { runCheck } from "./check.js";
import { runTests } from "./test.js";

/** Files below the helper folders of the headless route are never part of a publish. */
const isHelperFile = (f: string): boolean => /(^|[\\/])(_McpTest|_McpTmp)([\\/]|$)/.test(f);

/**
 * `abfc publish [--dry-run]`: check, build, test, audit, then list what would be published. Phase 1 never publishes:
 * this command does not call `bp_publish` and copies nothing into the mod.
 */
export async function publish(ctx: CliContext): Promise<number> {
  const { output, config, args } = ctx;
  const mod = config.mod.name;
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  try {
    if (!(await runCheck(ctx, rec))) return output.exitCode() || 1;
    if (!(await runBuild(ctx, session, rec))) return output.exitCode() || 1;
    if (!(await runTests(ctx, session, rec, undefined))) {
      if (output.exitCode() === 0) output.diag({ severity: "error", code: "ABFC6104", message: "one or more tests failed; not publishing." });
      return output.exitCode();
    }

    const { backend, info } = await session.open();
    if (!info.capabilities.stageAudit) {
      output.diag({
        severity: "warning",
        code: "ABFC7003",
        message: "mod_audit audits the real mod, not the staged copy; the audit below does not cover the staged changes.",
        fix: "audit the mod in the editor after the changes are published by hand.",
      });
    }
    const report = await backend.audit(mod);
    if (!report.ok) {
      output.diag({
        severity: "error",
        code: "ABFC7002",
        message: `mod_audit reported problems for ${mod}.`,
        fix: "run mod_audit in the editor for the details.",
      });
      return output.exitCode();
    }

    const stage = await backend.stageStatus(mod);
    const changed = (stage?.changed ?? []).filter((f) => !isHelperFile(f));
    const added = (stage?.added ?? []).filter((f) => !isHelperFile(f));
    output.info("would publish:");
    for (const f of changed) output.info(`  changed ${f}`);
    for (const f of added) output.info(`  added   ${f}`);
    if (changed.length + added.length === 0) output.info("  (nothing)");
    output.json({ changed, added, dryRun: args.flags.dryRun });

    if (args.flags.dryRun) return output.exitCode();
    output.diag({
      severity: "error",
      code: "ABFC7001",
      message: "publishing is disabled in Phase 1; nothing was copied into the mod.",
      fix: "use abfc publish --dry-run to see what would be published.",
    });
    return output.exitCode();
  } finally {
    await session.close();
    rec.print();
  }
}
