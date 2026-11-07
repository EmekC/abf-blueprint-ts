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

/** The TypeScript version the frontend was built against; a language service on another version must not use this frontend. */
export const TS_VERSION: string = ts.version;

/**
 * Hides what abfc owns now (and what is retired) from the `_Manual` interfaces of hand-made stubs.
 * Returns null when nothing is owned; the returned function returns `text` unchanged for every other file.
 */
export function ownedManualFilter(
  projectDir: string,
  onWarning?: (file: string, why: string) => void,
): ((fileName: string, text: string) => string) | null {
  const root = resolve(projectDir);
  // Stubs are generated before abfc owns a unit; what the manifests say abfc owns now is hidden from their `_Manual` interfaces.
  const owned = ownedSets(root);
  // The active profile is not known here, so every profile's retired.json is read; an unreadable one is ignored with a warning.
  const retiredByAsset = readRetired(root, undefined, (file, why) => onWarning?.(file, why));
  for (const [asset, ids] of Object.entries(retiredByAsset)) {
    const cur = owned[asset] ?? { units: [], variables: [] };
    owned[asset] = { units: [...cur.units, ...ids], variables: cur.variables };
  }
  if (Object.keys(owned).length === 0) return null;
  const stubsRoot = resolve(root, ".abfc", "stubs");
  const underStubs = (file: string): boolean => {
    const rel = relative(stubsRoot, resolve(file));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  return (fileName, text) => {
    if (!fileName.endsWith(".d.ts") || !underStubs(fileName) || !text.includes("@bpHandMade")) return text;
    return filterOwnedManual(fileName, text, owned);
  };
}

/** TypeScript's own diagnostics of a program (config, syntax, options, semantics) as ABFC2000. */
export function tsDiagnostics(program: ts.Program, projectDir: string): Diagnostic[] {
  const root = resolve(projectDir);
  const out: Diagnostic[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const x = fromTs(d, root);
    if (x) out.push(x);
  }
  return out;
}

/** Splits the root files of a program into class files and test files (files ending `.test.ts`); `.d.ts` roots are skipped. */
export function loadedFromProgram(projectDir: string, program: ts.Program, diagnostics: Diagnostic[]): LoadedProgram {
  const root = resolve(projectDir);
  const classes: ts.SourceFile[] = [];
  const tests: ts.SourceFile[] = [];
  for (const name of program.getRootFileNames()) {
    if (name.endsWith(".d.ts")) continue;
    const sf = program.getSourceFile(name);
    if (!sf) continue;
    (relFile(root, sf.fileName).endsWith(".test.ts") ? tests : classes).push(sf);
  }
  return { projectDir: root, program, checker: program.getTypeChecker(), files: { classes, tests }, diagnostics };
}

/**
 * `<projectDir>/tsconfig.json` -> program. Class files are the root files not ending `.test.ts`; test files end `.test.ts`.
 * `oldProgram` lets TypeScript reuse unchanged files and structure (watch mode).
 */
export function loadProgram(projectDir: string, oldProgram?: ts.Program): LoadedProgram {
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
  const filter = ownedManualFilter(root, (file, why) =>
    diagnostics.push({ severity: "warning", code: "ABFC2000", message: `ignoring unreadable ${file}: ${why}; run abfc stubs to rewrite it` }),
  );
  const host = ts.createCompilerHost(parsed.options);
  if (filter !== null) {
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
      const sf = getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreate);
      if (sf === undefined) return sf;
      const text = filter(fileName, sf.text);
      return text === sf.text ? sf : ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    };
  }
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    host,
    ...(parsed.projectReferences ? { projectReferences: parsed.projectReferences } : {}),
    ...(oldProgram ? { oldProgram } : {}),
  });
  diagnostics.push(...tsDiagnostics(program, root));
  return loadedFromProgram(root, program, diagnostics);
}
