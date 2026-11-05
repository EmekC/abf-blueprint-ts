import { compileTests } from "@abfc/compiler";
import type { CliContext } from "../context.js";
import { Recorder, compileFrontend, countUnits, emitAll, hasErrors, lockDiagnostics, since } from "./common.js";

/** Lock check, TypeScript check, HIR, lowering and test compilation. Returns true when there is no error. */
export async function runCheck(ctx: CliContext, rec: Recorder): Promise<boolean> {
  const t0 = performance.now();
  if (emitAll(ctx, lockDiagnostics(ctx, "check"))) {
    rec.record("check.frontend", since(t0), false);
    return false;
  }
  const fe = compileFrontend(ctx);
  let tests = 0;
  if (fe.ir !== null) {
    const compiled = compileTests(fe.loaded, ctx.env.profile);
    emitAll(ctx, compiled.diagnostics);
    tests = compiled.cases.length;
  }
  const ok = fe.ir !== null && !hasErrors(ctx);
  rec.record("check.frontend", since(t0), ok, fe.ir === null ? 0 : countUnits(fe.ir));
  if (ok && fe.ir !== null) {
    const units = countUnits(fe.ir);
    ctx.output.info(`checked ${units} unit(s) in ${fe.ir.assets.length} asset(s), ${tests} test(s): no errors`);
    ctx.output.json({ assets: fe.ir.assets.map((a) => ({ asset: a.path, units: a.units.map((u) => u.id) })), tests });
  }
  return ok;
}

/** `abfc check`: no backend needed. */
export async function check(ctx: CliContext): Promise<number> {
  const rec = new Recorder(ctx);
  await runCheck(ctx, rec);
  rec.print();
  return ctx.output.exitCode();
}
