// Loads the user's TypeScript project (tsconfig + stubs) and reports TypeScript's own diagnostics as ABFC2000.
import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import type { Diagnostic } from "@abfc/ir";
import { ownedSets, readRetired } from "../ownership/manifest.js";
import { relFile, spanOfRange } from "./diag.js";
import { filterOwnedManual } from "./manualfilter.js";

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
  // Stubs are generated before abfc owns a unit; what the manifests say abfc owns now is hidden from their `_Manual` interfaces.
  const owned = ownedSets(root);
  // The active profile is not known here, so every profile's retired.json is read; an unreadable one is ignored with a warning.
  const retiredByAsset = readRetired(root, undefined, (file, why) =>
    diagnostics.push({ severity: "warning", code: "ABFC2000", message: `ignoring unreadable ${file}: ${why}; run abfc stubs to rewrite it` }),
  );
  for (const [asset, ids] of Object.entries(retiredByAsset)) {
    const cur = owned[asset] ?? { units: [], variables: [] };
    owned[asset] = { units: [...cur.units, ...ids], variables: cur.variables };
  }
  const stubsRoot = resolve(root, ".abfc", "stubs");
  const underStubs = (file: string): boolean => {
    const rel = relative(stubsRoot, resolve(file));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  const host = ts.createCompilerHost(parsed.options);
  if (Object.keys(owned).length > 0) {
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
      const sf = getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
      if (sf === undefined || !fileName.endsWith(".d.ts") || !underStubs(fileName) || !sf.text.includes("@bpHandMade")) return sf;
      const text = filterOwnedManual(fileName, sf.text, owned);
      return text === sf.text ? sf : ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    };
  }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
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
