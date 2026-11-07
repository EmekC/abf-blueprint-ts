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

export type TsProgram = ts.Program;
export type TsSourceFile = ts.SourceFile;

/** Keeps parsed source files between programs: the same `SourceFile` object comes back while a file's text is unchanged. */
export class SourceFileCache {
  private readonly files = new Map<string, { text: string; sf: ts.SourceFile }>();

  private static keyOf(fileName: string, langOpts: ts.ScriptTarget | ts.CreateSourceFileOptions): string {
    const o = typeof langOpts === "number" ? String(langOpts) : `${langOpts.languageVersion}:${langOpts.impliedNodeFormat ?? ""}:${langOpts.jsDocParsingMode ?? ""}`;
    return `${fileName.replaceAll("\\", "/").toLowerCase()}|${o}`;
  }

  /** The cached source file when `text` is unchanged, else a freshly parsed one (which replaces the entry). */
  get(fileName: string, text: string, langOpts: ts.ScriptTarget | ts.CreateSourceFileOptions): ts.SourceFile {
    const key = SourceFileCache.keyOf(fileName, langOpts);
    const hit = this.files.get(key);
    if (hit !== undefined && hit.text === text) return hit.sf;
    const sf = ts.createSourceFile(fileName, text, langOpts, true);
    this.files.set(key, { text, sf });
    return sf;
  }

  /** Drops the entries whose file is not part of `program`. */
  retain(program: ts.Program): void {
    const keep = new Set<string>();
    for (const sf of program.getSourceFiles()) keep.add(sf.fileName.replaceAll("\\", "/").toLowerCase());
    // An entry key is `<file>|<options>`; the file part decides, every option variant of a kept file stays.
    for (const key of [...this.files.keys()]) {
      if (!keep.has(key.slice(0, key.lastIndexOf("|")))) this.files.delete(key);
    }
  }

  get size(): number {
    return this.files.size;
  }
}

export interface LoadProgramOptions {
  /** Text for a file that differs from the disk (open editor buffers); undefined = read the disk. */
  overlay?: (fileName: string) => string | undefined;
  /** Reuses source files between calls. */
  cache?: SourceFileCache;
}

/**
 * `<projectDir>/tsconfig.json` -> program. Class files are the root files not ending `.test.ts`; test files end `.test.ts`.
 * `oldProgram` lets TypeScript reuse unchanged files and structure (watch mode).
 */
export function loadProgram(projectDir: string, oldProgram?: ts.Program, opts: LoadProgramOptions = {}): LoadedProgram {
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
  const { overlay, cache } = opts;
  if (filter !== null || overlay !== undefined || cache !== undefined) {
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.readFile = (f) => overlay?.(f) ?? readFile(f);
    host.fileExists = (f) => overlay?.(f) !== undefined || fileExists(f);
    host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
      let text = overlay?.(fileName) ?? ts.sys.readFile(fileName);
      if (text === undefined) {
        onError?.("cannot read " + fileName);
        return undefined;
      }
      if (filter !== null) text = filter(fileName, text);
      return cache ? cache.get(fileName, text, languageVersionOrOptions) : ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
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
