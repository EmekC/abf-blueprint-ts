// abfc diagnostics -> LSP diagnostics, and offset <-> range helpers.
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import type { Diagnostic as LspDiagnostic, Range } from "vscode-languageserver/node.js";
import type { TsSourceFile } from "@abfc/compiler";
import type { Diagnostic, Span } from "@abfc/ir";

/** Where an `ABFCnnnn` code is described (the page arrives with the 1.0 docs set). */
export const ERRORS_DOC_URL = "https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/errors.md";
/** Where a lint rule is described; the anchor is the rule name without the `abfc/` prefix. */
export const LINT_DOC_URL = "https://github.com/EmekC/abf-blueprint-ts/blob/main/docs/lint-rules.md";

const ZERO: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };

const nonNegative = (n: number): number => Math.max(0, n);

function rangeOfSpan(s: Span): Range {
  return {
    start: { line: nonNegative(s.line - 1), character: nonNegative(s.col - 1) },
    end: { line: nonNegative(s.endLine - 1), character: nonNegative(s.endCol - 1) },
  };
}

function base(d: Diagnostic, range: Range): LspDiagnostic {
  const out: LspDiagnostic = {
    range,
    severity: d.severity === "error" ? DiagnosticSeverity.Error : d.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
    code: d.code,
    source: "abfc",
    message: d.fix !== undefined ? `${d.message}\n${d.fix}` : d.message,
    codeDescription: { href: `${ERRORS_DOC_URL}#${d.code.toLowerCase()}` },
  };
  if (d.data !== undefined) out.data = d.data;
  return out;
}

/** The diagnostic at its span; a diagnostic without a span sits at 0:0. */
export function toLspDiagnostic(d: Diagnostic): LspDiagnostic {
  return base(d, d.span !== undefined ? rangeOfSpan(d.span) : ZERO);
}

/** For config-level codes (ABFC3001 to ABFC3003, a config that does not load): always the first character of the file. */
export function atFileStart(d: Diagnostic): LspDiagnostic {
  return base(d, ZERO);
}

/** UTF-16 offsets of a 1-based span in `sf`. */
export function spanOffsets(sf: TsSourceFile, span: Span): { start: number; end: number } {
  return {
    start: sf.getPositionOfLineAndCharacter(nonNegative(span.line - 1), nonNegative(span.col - 1)),
    end: sf.getPositionOfLineAndCharacter(nonNegative(span.endLine - 1), nonNegative(span.endCol - 1)),
  };
}

/** The 0-based LSP range of two UTF-16 offsets in `sf`. */
export function offsetRange(sf: TsSourceFile, start: number, end: number): Range {
  const a = sf.getLineAndCharacterOfPosition(start);
  const b = sf.getLineAndCharacterOfPosition(end);
  return { start: { line: a.line, character: a.character }, end: { line: b.line, character: b.character } };
}
