// The check path shared by `abfc check` and the language service: HIR -> IR -> tests, as one list of diagnostics.
import { validateIrModule } from "@abfc/ir";
import type { Diagnostic, IrModule, Profile } from "@abfc/ir";
import { buildHir } from "./frontend/build.js";
import type { LoadedProgram } from "./frontend/program.js";
import { compileTests } from "./frontend/tests.js";
import type { HirProgram } from "./hir.js";
import { lower } from "./lower/index.js";

/** HIR -> IR, then IR validation. A validation problem is an ABFC2099 error and `ir` is null. */
export function lowerChecked(hir: HirProgram, profile: Profile): { ir: IrModule | null; diagnostics: Diagnostic[] } {
  const ir = lower(hir, profile);
  const problems = validateIrModule(ir);
  const diagnostics: Diagnostic[] = [];
  for (const p of problems) {
    const unit = ir.assets.flatMap((a) => a.units.map((u) => ({ key: `${a.path} ${u.id}: `, u }))).find((x) => p.startsWith(x.key));
    diagnostics.push({
      severity: "error",
      code: "ABFC2099",
      message: `internal: ${p}`,
      ...(unit ? { span: unit.u.origin } : {}),
    });
  }
  return { ir: problems.length > 0 ? null : ir, diagnostics };
}

export interface ProjectCheck {
  hir: HirProgram;
  /** null when TypeScript, the subset checker or IR validation reported an error. */
  ir: IrModule | null;
  /** The subset checker's, the lowering's and the tests' diagnostics; `loaded.diagnostics` are not repeated here. */
  diagnostics: Diagnostic[];
  /** Number of test cases that compiled. */
  tests: number;
}

/** Whole-project check: all class files -> HIR -> (when clean) IR -> test cases. */
export function checkProject(loaded: LoadedProgram, config: { mod: string }, profile: Profile): ProjectCheck {
  const hir = buildHir(loaded, config, profile);
  const diagnostics: Diagnostic[] = [...hir.diagnostics];
  const failed = [...loaded.diagnostics, ...hir.diagnostics].some((d) => d.severity === "error");
  if (failed) return { hir, ir: null, diagnostics, tests: 0 };
  const lowered = lowerChecked(hir, profile);
  diagnostics.push(...lowered.diagnostics);
  if (lowered.ir === null) return { hir, ir: null, diagnostics, tests: 0 };
  const compiled = compileTests(loaded, profile);
  diagnostics.push(...compiled.diagnostics);
  return { hir, ir: lowered.ir, diagnostics, tests: compiled.cases.length };
}
