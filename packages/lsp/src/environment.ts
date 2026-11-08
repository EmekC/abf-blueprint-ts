// The environment the server checks against: resolved like `abfc check`, but nothing except the registry lookup is ever started.
import type { CompilerProjectConfig } from "@abfc/compiler";
import { realHost, resolveEnvironment } from "@abfc/env";
import type { Environment, Host, ProjectConfig } from "@abfc/env";

/** The real host, except that `run` only executes `reg` (the Documents folder lookup); Python and the backend are never started. */
export function lspHost(): Host {
  const real = realHost();
  return {
    ...real,
    run: (cmd, args) => (cmd === "reg" ? real.run(cmd, args) : { status: null, stdout: "", stderr: "not run by abfc lsp" }),
  };
}

/** Throws AbfcError (ABFC1020, ABFC1021, a config that does not load); everything else is a diagnostic inside the result. */
export function loadProjectEnvironment(dir: string): Environment {
  return resolveEnvironment(lspHost(), { projectDir: dir, flags: {} });
}

/** What the compiler frontend needs from the project config (derived asset paths, migration hints). */
export function compilerConfigOf(config: ProjectConfig): CompilerProjectConfig {
  return {
    mod: config.mod.name,
    sourceRoot: config.sourceRoot,
    migrationHints: config.schemaVersion >= 2,
    classManagerTable: config.classManager.table,
  };
}
