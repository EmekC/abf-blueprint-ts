import { exitCodeFor, formatDiagnostic } from "@abfc/env";
import type { Diagnostic } from "@abfc/ir";
import type { Progress } from "./progress.js";
import { PLAIN, paintDiagnostic } from "./style.js";
import type { Styler, Tone } from "./style.js";

export interface OutputOptions {
  command: string;
  json: boolean;
  projectDir?: string | undefined;
  /** Informational lines (default: process.stdout). */
  stdout?: ((line: string) => void) | undefined;
  /** Diagnostics (default: process.stderr). */
  stderr?: ((line: string) => void) | undefined;
  /** Routes writes through the progress renderer so a live spinner line is cleared and redrawn around them. */
  progress?: Progress | undefined;
  /** Colors for result lines on stdout (default: none). */
  stdoutStyle?: Styler | undefined;
  /** Colors for diagnostics on stderr (default: none). */
  stderrStyle?: Styler | undefined;
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
    if (this.o.json) return;
    let text = paintDiagnostic(formatDiagnostic(d, this.o.projectDir), d.severity, this.o.stderrStyle ?? PLAIN);
    const progress = this.o.progress;
    if (progress?.live === true && progress.activeStep !== null && d.span === undefined) {
      text = text
        .split("\n")
        .map((l) => "  " + l)
        .join("\n");
    }
    this.emit(() => this.err(text));
  }

  info(line: string, tone?: Tone): void {
    if (this.o.json) return;
    const style = this.o.stdoutStyle;
    const text = tone !== undefined && style !== undefined ? style.paint(tone, line) : line;
    this.emit(() => this.out(text));
  }

  private emit(fn: () => void): void {
    const progress = this.o.progress;
    if (progress !== undefined) progress.write(fn);
    else fn();
  }

  /** Sets the machine-readable result that `--json` prints (ignored in text mode). */
  json(obj: unknown): void {
    this.result = obj;
  }

  /** The result set by json() so far (undefined when none). */
  resultSoFar(): unknown {
    return this.result;
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
