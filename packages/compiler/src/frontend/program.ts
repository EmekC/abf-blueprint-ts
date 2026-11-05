// Loads the user's TypeScript project (tsconfig + stubs) and reports TypeScript's own diagnostics as ABFC2000.
import { resolve } from "node:path";
import ts from "typescript";
import type { Diagnostic } from "@abfc/ir";
import { relFile, spanOfRange } from "./diag.js";

export interface LoadedProgram {
  /** Absolute project directory. */
  projectDir: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  files: { classes: ts.SourceFile[]; tests: ts.SourceFile[] };
  diagnostics: Diagnostic[];
}

function fromTs(d: ts.Diagnostic, root: string): Diagnostic | undefined {
  if (d.category !== ts.DiagnosticCategory.Error && d.category !== ts.DiagnosticCategory.Warning) return undefined;
  const out: Diagnostic = {
    severity: d.category === ts.DiagnosticCategory.Error ? "error" : "warning",
    code: "ABFC2000",
    message: `[TS${d.code}] ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
  };
  if (d.file !== undefined && d.start !== undefined) out.span = spanOfRange(d.file, d.start, d.start + (d.length ?? 0), root);
  return out;
}

/** `<projectDir>/tsconfig.json` -> program. Class files are the root files not ending `.test.ts`; test files end `.test.ts`. */
export function loadProgram(projectDir: string): LoadedProgram {
  const root = resolve(projectDir);
  const configPath = resolve(root, "tsconfig.json");
  const fatal: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        fatal.push(d);
      },
    },
  );
  const diagnostics: Diagnostic[] = [];
  for (const d of fatal) {
    const x = fromTs(d, root);
    if (x) diagnostics.push(x);
  }
  if (!parsed) {
    const program = ts.createProgram({ rootNames: [], options: {} });
    return { projectDir: root, program, checker: program.getTypeChecker(), files: { classes: [], tests: [] }, diagnostics };
  }
  for (const d of parsed.errors) {
    const x = fromTs(d, root);
    if (x) diagnostics.push(x);
  }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
  });
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const x = fromTs(d, root);
    if (x) diagnostics.push(x);
  }
  const classes: ts.SourceFile[] = [];
  const tests: ts.SourceFile[] = [];
  for (const name of parsed.fileNames) {
    if (name.endsWith(".d.ts")) continue;
    const sf = program.getSourceFile(name);
    if (!sf) continue;
    (relFile(root, sf.fileName).endsWith(".test.ts") ? tests : classes).push(sf);
  }
  return { projectDir: root, program, checker: program.getTypeChecker(), files: { classes, tests }, diagnostics };
}
