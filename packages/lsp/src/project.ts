// One compiler state per project folder (the folder holding abf.config.json): environment, last program, last check.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Diagnostic as LspDiagnostic } from "vscode-languageserver/node.js";
import { SourceFileCache, buildCompletionIndex, checkProject, completionIndexOf, loadProgram } from "@abfc/compiler";
import type { CompletionIndex, LoadedProgram, ProjectCheck, TsSourceFile } from "@abfc/compiler";
import { AbfcError, PROJECT_CONFIG_FILE } from "@abfc/env";
import type { Environment } from "@abfc/env";
import type { Diagnostic } from "@abfc/ir";
import { checkLock, readLock } from "@abfc/stubgen";
import { atFileStart, toLspDiagnostic } from "./convert.js";
import { compilerConfigOf, loadProjectEnvironment } from "./environment.js";
import { ProjectLinter } from "./lint.js";
import { pathKey, pathToUri } from "./uri.js";

/** The `initializationOptions` the server understands. */
export interface InitOptions {
  /** Report TypeScript's own errors as ABFC2000 (for editors without a TypeScript server). Default false. */
  tsDiagnostics?: boolean;
  /** Add the symbol and its TypeScript type to the hover. Default false. */
  tsHover?: boolean;
  /** Run the `@abfc/eslint-plugin` recommended rules. Default true. */
  lint?: boolean;
  /** Wait this long after the last change before checking. Default 300. */
  debounceMs?: number;
}

export interface Snapshot {
  loaded: LoadedProgram;
  check: ProjectCheck;
  /** The program's source file of every open document, by path key. */
  byKey: Map<string, TsSourceFile>;
  /** Lint findings by path key (filled on demand). */
  lint: Map<string, LspDiagnostic[]>;
}

const fwd = (p: string): string => p.replaceAll("\\", "/");
const sameFile = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

const isTsDiagnostic = (d: Diagnostic): boolean => d.code === "ABFC2000" && d.message.startsWith("[TS");

/** How long a disk stamp stays valid (like the old tsserver plugin's manifest token). */
export const DISK_STAMP_TTL_MS = 1000;

function statLine(label: string, path: string): string {
  try {
    const s = statSync(path);
    return `${label}:${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

function jsonNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * A string that changes when something the check depends on changes on disk: the manifests, each stub profile's
 * `retired.json` and `stubs.lock.json`, `abf.config.json`, `tsconfig.json` and `.abfc/tsconfig.paths.json`
 * (mtime and size of each, so a file that appears or disappears also changes it).
 */
export function diskStamp(dir: string): string {
  const parts: string[] = [];
  const add = (label: string, path: string): void => {
    const line = statLine(label, path);
    if (line !== "") parts.push(line);
  };
  add(PROJECT_CONFIG_FILE, join(dir, PROJECT_CONFIG_FILE));
  add("tsconfig.json", join(dir, "tsconfig.json"));
  add("tsconfig.paths.json", join(dir, ".abfc", "tsconfig.paths.json"));
  const manifests = join(dir, ".abfc", "manifest");
  for (const name of jsonNames(manifests)) add(`manifest/${name}`, join(manifests, name));
  const stubs = join(dir, ".abfc", "stubs");
  for (const profile of subdirs(stubs)) {
    add(`${profile}/retired.json`, join(stubs, profile, "retired.json"));
    add(`${profile}/stubs.lock.json`, join(stubs, profile, "stubs.lock.json"));
  }
  return parts.join("|");
}

export class ProjectState {
  readonly configUri: string;
  /** Open documents of this project by path key. Their text lives in the server's document store. */
  readonly docs = new Map<string, { uri: string; path: string }>();
  configError: Diagnostic | null = null;
  env: Environment | null = null;

  private readonly cache = new SourceFileCache();
  private last: Snapshot | null = null;
  private dirty = true;
  private reloadConfig = true;
  private configStamp = "";
  private diskStampValue: string | null = null;
  private diskStampAt = 0;
  private readonly linter: ProjectLinter;

  constructor(
    readonly dir: string,
    private readonly overlay: (fileName: string) => string | undefined,
    onLog: (message: string) => void = () => undefined,
  ) {
    this.configUri = pathToUri(join(dir, PROJECT_CONFIG_FILE));
    this.linter = new ProjectLinter(dir, onLog);
  }

  /** Marks the project dirty when the disk stamp changed (recomputed at most once per second). */
  private checkDisk(): void {
    const now = Date.now();
    if (this.diskStampValue !== null && now - this.diskStampAt < DISK_STAMP_TTL_MS) return;
    this.diskStampAt = now;
    const stamp = diskStamp(this.dir);
    if (this.diskStampValue !== null && stamp !== this.diskStampValue) this.dirty = true;
    this.diskStampValue = stamp;
  }

  /** The next `snapshot()` rebuilds the program; `reloadConfig` also re-reads abf.config.json and the environment. */
  markDirty(reloadConfig = false): void {
    this.dirty = true;
    if (reloadConfig) this.reloadConfig = true;
  }

  /** The key of a project file in `docs`. */
  static keyOf(path: string): string {
    return pathKey(path);
  }

  private stampOfConfig(): string {
    try {
      const s = statSync(join(this.dir, PROJECT_CONFIG_FILE));
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "missing";
    }
  }

  /** Re-reads the config and environment when forced or when the file changed. */
  private ensureConfig(): void {
    const stamp = this.stampOfConfig();
    if (!this.reloadConfig && stamp === this.configStamp) return;
    this.reloadConfig = false;
    this.configStamp = stamp;
    this.dirty = true;
    try {
      this.env = loadProjectEnvironment(this.dir);
      this.configError = null;
    } catch (e) {
      if (!(e instanceof AbfcError)) throw e;
      this.env = null;
      this.configError = e.diagnostic;
    }
  }

  /** The program and check of the current text of every open document; null when the config does not load. */
  snapshot(): Snapshot | null {
    this.ensureConfig();
    this.checkDisk();
    const env = this.env;
    if (env === null) return null;
    if (this.last !== null && !this.dirty) return this.last;
    const loaded = loadProgram(this.dir, this.last?.loaded.program, { overlay: this.overlay, cache: this.cache });
    const check = checkProject(loaded, compilerConfigOf(env.config), env.profile);
    const byKey = new Map<string, TsSourceFile>();
    for (const [key, doc] of this.docs) {
      const sf = loaded.program.getSourceFile(doc.path);
      if (sf !== undefined) byKey.set(key, sf);
    }
    this.last = { loaded, check, byKey, lint: new Map() };
    this.dirty = false;
    return this.last;
  }

  /**
   * The completion index of the project's stubs profile: the generated library functions and the class, struct, enum and function names of
   * the catalog (memoised by the compiler while `stubs.lock.json` and `_names.json` keep their modification times); empty without a loaded config.
   */
  completionIndex(): CompletionIndex {
    this.ensureConfig();
    if (this.env === null) return completionIndexOf([]);
    return buildCompletionIndex(join(this.dir, ".abfc", "stubs", this.env.profile.id));
  }

  /** abfc's own diagnostics (the subset checker's, the lowering's, the moved-class check) located in `sf`, without TypeScript's. */
  abfcDiagnosticsOf(snap: Snapshot, sf: TsSourceFile): Diagnostic[] {
    const rel = fwd(relative(snap.loaded.projectDir, sf.fileName));
    return snap.check.diagnostics.filter((d) => d.span !== undefined && sameFile(d.span.file, rel) && !isTsDiagnostic(d));
  }

  /** TypeScript's diagnostics (ABFC2000 `[TSnnnn]`) located in `sf`: the ones of the program load and any the check carries. */
  tsDiagnosticsOf(snap: Snapshot, sf: TsSourceFile): Diagnostic[] {
    const rel = fwd(relative(snap.loaded.projectDir, sf.fileName));
    return [...snap.loaded.diagnostics, ...snap.check.diagnostics].filter((d) => d.span !== undefined && sameFile(d.span.file, rel) && isTsDiagnostic(d));
  }

  /** What the editor shows for one open file. */
  fileDiagnostics(path: string, opts: InitOptions): LspDiagnostic[] {
    const snap = this.snapshot();
    if (snap === null) return [];
    const sf = snap.byKey.get(pathKey(path));
    if (sf === undefined) return [];
    const out = this.abfcDiagnosticsOf(snap, sf).map(toLspDiagnostic);
    if (opts.tsDiagnostics === true) out.push(...this.tsDiagnosticsOf(snap, sf).map(toLspDiagnostic));
    if (opts.lint !== false && !sf.fileName.endsWith(".d.ts")) {
      const key = pathKey(path);
      let findings = snap.lint.get(key);
      if (findings === undefined) {
        findings = this.linter.lint(snap.loaded, sf);
        snap.lint.set(key, findings);
      }
      out.push(...findings);
    }
    return out;
  }

  /** Config-level diagnostics for abf.config.json: the stub lock codes, or the reason the config does not load. */
  configDiagnostics(): LspDiagnostic[] {
    this.ensureConfig();
    if (this.env === null) return this.configError !== null ? [atFileStart(this.configError)] : [];
    const env = this.env;
    const lock = readLock(join(this.dir, ".abfc", "stubs", env.profile.id));
    return checkLock(lock, env, env.config, "check").map(atFileStart);
  }
}
