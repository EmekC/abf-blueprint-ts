import { compileTests, loadProgram } from "@abfc/compiler";
import type { TestCase } from "@abfc/ir";
import { evaluateTest, toGameTestSteps } from "@abfc/testkit/runner";
import type { CliContext } from "../context.js";
import { BackendSession, Recorder, compilerConfigOf, emitAll, lockDiagnostics, since } from "./common.js";
import { runBuild } from "./build.js";
import { writeManualChecks } from "./manualchecks.js";

/**
 * Compiles the matching tests and runs each through `bp_game_test`. The caller decides whether to build first.
 * Returns true when every test passed (and at least the compilation was clean).
 */
export async function runTests(ctx: CliContext, session: BackendSession, rec: Recorder, pattern: string | undefined): Promise<boolean> {
  const { output, config, env } = ctx;
  const mod = config.mod.name;
  const loaded = loadProgram(ctx.projectDir);
  if (emitAll(ctx, loaded.diagnostics)) return false;
  const compiled = compileTests(loaded, env.profile, pattern, compilerConfigOf(config));
  if (emitAll(ctx, compiled.diagnostics)) return false;
  const live: TestCase[] = compiled.cases.filter((c) => c.liveHud !== undefined);
  const cases: TestCase[] = compiled.cases.filter((c) => c.liveHud === undefined);
  const manualChecks = live.map((c) => ({ name: c.name, file: c.file, line: c.span.line, checklist: c.liveHud!.checklist }));
  for (const c of live) {
    output.diag({ severity: "warning", code: "ABFC6105", message: `${c.name} needs the live HUD; skipped hidden (manual check)`, span: c.span });
  }
  if (live.length > 0) output.info(`manual checks: ${writeManualChecks(ctx.projectDir, mod, live)}`);
  if (cases.length === 0) {
    if (live.length === 0) output.info(pattern === undefined ? "no tests found" : `no tests match "${pattern}"`);
    output.json(live.length > 0 ? { tests: [], manualChecks } : { tests: [] });
    return true;
  }

  const { backend } = await session.open("test.backendStart");
  let failed = 0;
  const results: Array<{ name: string; passed: boolean; ok: number; steps: number; seconds: number }> = [];
  for (const tc of cases) {
    const t0 = performance.now();
    const report = await backend.gameTest(mod, toGameTestSteps(tc), { timeoutSeconds: 180 });
    const ev = evaluateTest(tc, report);
    rec.record(`test.${tc.name}`, since(t0), ev.passed, tc.steps.length);
    output.info(`${ev.passed ? "PASS" : "FAIL"} ${tc.name} (${ev.summary.ok}/${tc.steps.length}, ${report.seconds.toFixed(1)} s)`);
    for (const d of ev.diagnostics) output.diag(d);
    if (!ev.passed) failed++;
    results.push({ name: tc.name, passed: ev.passed, ok: ev.summary.ok, steps: tc.steps.length, seconds: report.seconds });
  }
  output.info(`${cases.length - failed} of ${cases.length} test(s) passed`);
  output.json(live.length > 0 ? { tests: results, manualChecks } : { tests: results });
  return failed === 0;
}

/** `abfc test [pattern] [--no-build]`. */
export async function test(ctx: CliContext): Promise<number> {
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  try {
    if (!ctx.args.flags.noBuild) {
      if (!(await runBuild(ctx, session, rec))) return ctx.output.exitCode() || 1;
    } else if (emitAll(ctx, lockDiagnostics(ctx, "build"))) {
      return ctx.output.exitCode();
    }
    const ok = await runTests(ctx, session, rec, ctx.args.positionals[0]);
    if (!ok && ctx.output.exitCode() === 0) {
      // a failed test is an error even when every diagnostic of it was a warning
      ctx.output.diag({ severity: "error", code: "ABFC6104", message: "one or more tests failed." });
    }
  } finally {
    await session.close();
    rec.print();
  }
  return ctx.output.exitCode();
}
