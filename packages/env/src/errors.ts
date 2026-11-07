import type { Diagnostic } from "@abfc/ir";

export type ExitCode = 1 | 2 | 3;

/** Exit code by diagnostic code (see the plan's error table): 0 ok is not an error. */
export function exitCodeFor(code: string): ExitCode {
  const n = Number(code.replace(/^ABFC/, ""));
  if (n === 7006) return 2;
  // abfc init: nested project, no terminal, mod not found, no mods in the folder are user errors (docs/design.md 18.5).
  if (n >= 1040 && n <= 1044) return 1;
  if (n === 1020 || n === 4090 || (n >= 5001 && n <= 5007) || n === 7005) return 3;
  if (n >= 2000 && n < 3000) return 1;
  if (n >= 6000 && n < 7000) return 1;
  if (n >= 1000 && n < 5000) return 2;
  return 1;
}

export class AbfcError extends Error {
  readonly diagnostic: Diagnostic;
  readonly exitCode: ExitCode;
  constructor(diagnostic: Diagnostic, exitCode?: ExitCode) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "AbfcError";
    this.diagnostic = diagnostic;
    this.exitCode = exitCode ?? exitCodeFor(diagnostic.code);
  }
}

export type Tried = Array<{ source: string; detail: string }>;

/** An environment error with what was tried and one concrete fix (design 9.3). `code` is the number, e.g. 1001. */
export function envError(code: number | string, title: string, tried: Tried, fix: string): AbfcError {
  return new AbfcError({ severity: "error", code: normalizeCode(code), message: title, tried, fix });
}

/** The warning form of {@link envError}; not thrown, collected in `Environment.diagnostics`. */
export function envWarning(code: number | string, title: string, tried: Tried, fix: string): Diagnostic {
  return { severity: "warning", code: normalizeCode(code), message: title, tried, fix };
}

function normalizeCode(code: number | string): string {
  return typeof code === "number" ? `ABFC${code}` : code;
}

/** Design 9.3 layout; with a span the first line is the problem-matcher form `<file>:<line>:<col>: <severity> <code>: <message>`. */
export function formatDiagnostic(d: Diagnostic, projectDir?: string): string {
  const lines: string[] = [];
  if (d.span) {
    lines.push(`${relPath(d.span.file, projectDir)}:${d.span.line}:${d.span.col}: ${d.severity} ${d.code}: ${d.message}`);
  } else {
    lines.push(`abfc: ${d.severity} ${d.code}: ${d.message}`);
  }
  if (d.tried && d.tried.length > 0) {
    lines.push("  tried:");
    for (const t of d.tried) lines.push(`    ${t.source.padEnd(28)} ${t.detail}`);
  }
  if (d.fix) lines.push(`  fix: ${d.fix}`);
  return lines.join("\n");
}

function relPath(file: string, projectDir?: string): string {
  let f = file.replace(/\\/g, "/");
  if (projectDir) {
    const base = projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (f.toLowerCase().startsWith(base.toLowerCase() + "/")) f = f.slice(base.length + 1);
  }
  return f;
}
