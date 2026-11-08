import type { ParsedArgs } from "../args.js";
import type { CliDeps } from "../context.js";

/**
 * `abfc lsp [--stdio]`: the language server over stdio (docs/language-service.md). Stdout carries only the protocol;
 * logs go to stderr. `@abfc/lsp` is loaded here so that the other commands do not pay for ESLint and the LSP libraries.
 */
export async function runLsp(_args: ParsedArgs, deps: CliDeps): Promise<number> {
  const { startServer } = await import("@abfc/lsp");
  return startServer({
    input: deps.lspStreams?.input ?? process.stdin,
    output: deps.lspStreams?.output ?? process.stdout,
    log: deps.stderr ?? ((line: string): void => void process.stderr.write(line + "\n")),
  });
}
