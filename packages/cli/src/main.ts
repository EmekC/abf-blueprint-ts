import { startBackend } from "@abfc/backend";
import { AbfcError, cleanBundledRuntimes, installInfo, realHost, verifyBundledRuntime } from "@abfc/env";
import { parseCliArgs, UsageError } from "./args.js";
import type { ParsedArgs } from "./args.js";
import { adopt } from "./commands/adopt.js";
import { build } from "./commands/build.js";
import { check } from "./commands/check.js";
import { cleanRuntimesCommand, doctor } from "./commands/doctor.js";
import { runInit } from "./commands/init.js";
import { runLsp } from "./commands/lsp.js";
import { publish } from "./commands/publish.js";
import { status } from "./commands/status.js";
import { stubs } from "./commands/stubs.js";
import { test } from "./commands/test.js";
import { loadContext } from "./context.js";
import type { CliContext, CliDeps } from "./context.js";
import { Output } from "./output.js";

export type CommandFn = (ctx: CliContext) => Promise<number>;

export const COMMANDS: Record<string, CommandFn> = {
  doctor,
  stubs,
  check,
  build,
  test,
  status,
  adopt,
  publish,
};

const USAGE = [
  "usage: abfc <command> [options]",
  "commands: init, lsp, " + Object.keys(COMMANDS).join(", "),
  "options: --json --verbose --project <dir> --editor-root <dir> --mods-dir <dir> --mod-dir <dir>",
  "         --backend-dir <dir> --python <exe> --headless-dir <dir> --timings --resync --no-build --yes --dry-run --full --discard-editor-changes --cold --watch (check)",
  "doctor:  abfc doctor [--deep] [--clean-runtimes]",
  "init:    abfc init [dir] [--mod <name>] [--yes] [--no-stubs] [--mods-dir <dir>] [--editor-root <dir>] [--backend-dir <dir>] [--python <exe>]",
  "lsp:     abfc lsp [--stdio]   language server over stdio (docs/language-service.md)",
];

export function defaultDeps(): CliDeps {
  return {
    host: realHost(),
    startBackend: (env, o) => startBackend(env, o),
    now: () => new Date(),
    install: { info: installInfo, verify: verifyBundledRuntime, clean: cleanBundledRuntimes },
  };
}

/** Runs one command line and returns the process exit code. Never throws. */
export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  const out = deps.stdout ?? ((line: string): void => void process.stdout.write(line + "\n"));
  const err = deps.stderr ?? ((line: string): void => void process.stderr.write(line + "\n"));

  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      err(`abfc: error: ${e.message}`);
      for (const l of USAGE) err(l);
      return 2;
    }
    throw e;
  }

  const command = args.command;
  if (command === null) {
    for (const l of USAGE) out(l);
    return 0;
  }
  if (command === "init") {
    try {
      return await runInit(args, deps);
    } catch (e) {
      const output = new Output({ command, json: args.flags.json, projectDir: args.flags.project, stdout: deps.stdout, stderr: deps.stderr });
      output.diag({
        severity: "error",
        code: "ABFC4002",
        message: `unexpected failure: ${e instanceof Error ? (args.flags.verbose ? (e.stack ?? e.message) : e.message) : String(e)}`,
      });
      output.finish();
      return 2;
    }
  }
  if (command === "lsp") {
    try {
      return await runLsp(args, deps);
    } catch (e) {
      err(`abfc: error: language server failed: ${e instanceof Error ? (args.flags.verbose ? (e.stack ?? e.message) : e.message) : String(e)}`);
      return 2;
    }
  }
  if (command === "doctor" && args.flags.cleanRuntimes) {
    try {
      return cleanRuntimesCommand(args, deps);
    } catch (e) {
      err(`abfc: error: could not clean the runtime folders: ${e instanceof Error ? (args.flags.verbose ? (e.stack ?? e.message) : e.message) : String(e)}`);
      return 2;
    }
  }
  const run = COMMANDS[command];
  if (run === undefined) {
    err(`abfc: error: unknown or not yet available command "${command}"`);
    for (const l of USAGE) err(l);
    return 2;
  }

  let ctx: CliContext | null = null;
  try {
    ctx = loadContext(args, deps);
    await run(ctx);
    return ctx.output.finish();
  } catch (e) {
    const output =
      ctx?.output ??
      new Output({ command, json: args.flags.json, projectDir: args.flags.project, stdout: deps.stdout, stderr: deps.stderr });
    if (e instanceof UsageError) {
      output.finish();
      err(`abfc: error: ${e.message}`);
      for (const l of USAGE) err(l);
      return 2;
    }
    if (e instanceof AbfcError) {
      output.diag(e.diagnostic);
      output.finish();
      return Math.max(e.exitCode, output.exitCode());
    }
    output.diag({
      severity: "error",
      code: "ABFC4002",
      message: `unexpected failure: ${e instanceof Error ? (args.flags.verbose ? (e.stack ?? e.message) : e.message) : String(e)}`,
    });
    output.finish();
    return 2;
  }
}
