import { exitCodeFor, formatDiagnostic } from "@abfc/env";
import type { Diagnostic } from "@abfc/ir";

export interface OutputOptions {
  command: string;
  json: boolean;
  projectDir?: string | undefined;
  /** Informational lines (default: process.stdout). */
  stdout?: ((line: string) => void) | undefined;
  /** Diagnostics (default: process.stderr). */
  stderr?: ((line: string) => void) | undefined;
}

/**
 * Text mode prints diagnostics as they arrive (problem-matcher form when they carry a span).
 * `--json` mode prints nothing until `finish()`, which writes one `{command, ok, diagnostics, result}` document.
 */
export class Output {
  readonly diagnostics: Diagnostic[] = [];
  private result: unknown = undefined;
  private readonly o: OutputOptions;
  private readonly out: (line: string) => void;
  private readonly err: (line: string) => void;

  constructor(o: OutputOptions) {
    this.o = o;
    this.out = o.stdout ?? ((line): void => void process.stdout.write(line + "\n"));
    this.err = o.stderr ?? ((line): void => void process.stderr.write(line + "\n"));
  }

  diag(d: Diagnostic): void {
    this.diagnostics.push(d);
    if (!this.o.json) this.err(formatDiagnostic(d, this.o.projectDir));
  }

  info(line: string): void {
    if (!this.o.json) this.out(line);
  }

  /** Sets the machine-readable result that `--json` prints (ignored in text mode). */
  json(obj: unknown): void {
    this.result = obj;
  }

  /** 0 when there is no error diagnostic, else the highest exit code of the errors (warnings never fail). */
  exitCode(): number {
    let code = 0;
    for (const d of this.diagnostics) {
      if (d.severity === "error") code = Math.max(code, exitCodeFor(d.code));
    }
    return code;
  }

  /** Prints the `--json` document (no-op in text mode) and returns the exit code. */
  finish(): number {
    const code = this.exitCode();
    if (this.o.json) {
      this.out(
        JSON.stringify({ command: this.o.command, ok: code === 0, diagnostics: this.diagnostics, result: this.result ?? null }, null, 2),
      );
    }
    return code;
  }
}
