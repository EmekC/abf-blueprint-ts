import { isExe } from "@abfc/env";
import type { ParsedArgs } from "../args.js";
import type { CliDeps } from "../context.js";

/**
 * `abfc lsp [--stdio]`: the language server over stdio (docs/language-service.md). Stdout carries only the protocol;
 * logs go to stderr. `@abfc/lsp` is loaded here so that the other commands do not pay for ESLint and the LSP libraries.
 * The server gets the command line that started this process, so its "Generate stubs" quick fix can run `abfc stubs`.
 */
export async function runLsp(_args: ParsedArgs, deps: CliDeps): Promise<number> {
  const { startServer } = await import("@abfc/lsp");
  const script = process.argv[1];
  const cliLaunch = isExe()
    ? { command: process.execPath, args: [] as string[] }
    : script === undefined
      ? undefined
      : { command: process.execPath, args: [...process.execArgv, script] };
  return startServer({
    input: deps.lspStreams?.input ?? process.stdin,
    output: deps.lspStreams?.output ?? process.stdout,
    log: deps.stderr ?? ((line: string): void => void process.stderr.write(line + "\n")),
    ...(cliLaunch !== undefined ? { cliLaunch } : {}),
  });
}
