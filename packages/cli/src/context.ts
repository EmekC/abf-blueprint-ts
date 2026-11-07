import { win32 } from "node:path";
import type { Backend } from "@abfc/backend";
import { assertNotInModFolder, findProjectDir, resolveEnvironment } from "@abfc/env";
import type { Environment, Host, ProjectConfig } from "@abfc/env";
import type { ParsedArgs } from "./args.js";
import { Output } from "./output.js";

/** Everything with side effects that tests replace. */
export interface CliDeps {
  host: Host;
  startBackend: (env: Environment, o?: { cold: boolean }) => Promise<Backend>;
  now: () => Date;
  /** Lists the files below a mod folder for the publish file check (default: a read-only walk of the real file system). */
  listFiles?: ((root: string) => Array<{ rel: string; size: number }>) | undefined;
  /**
   * Watches a folder tree for `abfc check --watch` and calls `onChange` with the absolute path of every changed file
   * (default: `fs.watch(dir, { recursive: true })`).
   */
  watch?: ((dir: string, onChange: (file: string) => void) => { close(): void }) | undefined;
  /** Ends `abfc check --watch` when aborted (default: aborted by SIGINT). */
  stopSignal?: AbortSignal | undefined;
  /** Folder the command line is relative to (default: `process.cwd()`). */
  cwd?: string | undefined;
  stdout?: ((line: string) => void) | undefined;
  stderr?: ((line: string) => void) | undefined;
  /** File writes of `abfc init` (default: `node:fs`; `writeFile` creates no folders, `mkdir` creates them recursively). */
  fs?: { writeFile(p: string, text: string): void; mkdir(p: string): void } | undefined;
  /** Asks one question and returns the answer (default: `node:readline/promises` on stdin and stdout). */
  prompt?: ((question: string) => Promise<string>) | undefined;
  /** Whether `abfc init` may ask questions (default: stdin and stdout are both terminals). */
  interactive?: boolean | undefined;
}

export interface CliPaths {
  abfcDir: string;
  cacheDir: string;
  stubsDir: string;
  manifestDir: string;
  sourcemapDir: string;
  runsFile: string;
}

export interface CliContext {
  args: ParsedArgs;
  deps: CliDeps;
  projectDir: string;
  config: ProjectConfig;
  env: Environment;
  output: Output;
  paths: CliPaths;
}

export function pathsFor(projectDir: string): CliPaths {
  const abfcDir = win32.join(projectDir, ".abfc");
  return {
    abfcDir,
    cacheDir: win32.join(abfcDir, "cache"),
    stubsDir: win32.join(abfcDir, "stubs"),
    manifestDir: win32.join(abfcDir, "manifest"),
    sourcemapDir: win32.join(abfcDir, "sourcemaps"),
    runsFile: win32.join(abfcDir, "runs.jsonl"),
  };
}

/**
 * Finds the project (`--project` or the working folder, walking up to `abf.config.json`), refuses a project inside a mod
 * folder (ABFC1020) and resolves the environment. Throws AbfcError only for ABFC1020 and ABFC1021.
 */
export function loadContext(args: ParsedArgs, deps: CliDeps): CliContext {
  const start = args.flags.project ?? deps.cwd ?? process.cwd();
  const projectDir = findProjectDir(start, (p) => deps.host.exists(p));
  assertNotInModFolder(deps.host, projectDir);
  const f = args.flags;
  const flags: Parameters<typeof resolveEnvironment>[1]["flags"] = {};
  if (f.editorRoot !== undefined) flags.editorRoot = f.editorRoot;
  if (f.modsDir !== undefined) flags.modsDir = f.modsDir;
  if (f.modDir !== undefined) flags.modDir = f.modDir;
  if (f.backendDir !== undefined) flags.backendDir = f.backendDir;
  if (f.python !== undefined) flags.python = f.python;
  if (f.headlessDir !== undefined) flags.headlessDir = f.headlessDir;
  const env = resolveEnvironment(deps.host, { projectDir, flags });
  const output = new Output({
    command: args.command ?? "",
    json: f.json,
    projectDir,
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
  return { args, deps, projectDir, config: env.config, env, output, paths: pathsFor(projectDir) };
}
