// Spans and diagnostic collection for the frontend (the only place that maps TypeScript nodes to `Span`).
import { relative } from "node:path";
import ts from "typescript";
import type { Diagnostic, Span } from "@abfc/ir";

const fwd = (p: string): string => p.replaceAll("\\", "/");

/** Project-relative file name with forward slashes. */
export function relFile(root: string, fileName: string): string {
  return fwd(relative(root, fileName));
}

/** 1-based line/column span of a node; `root` is the project directory. */
export function spanOf(node: ts.Node, root: string): Span {
  const sf = node.getSourceFile();
  return spanOfRange(sf, node.getStart(sf), node.getEnd(), root);
}

export function spanOfRange(sf: ts.SourceFile, start: number, end: number, root: string): Span {
  const a = sf.getLineAndCharacterOfPosition(start);
  const b = sf.getLineAndCharacterOfPosition(end);
  return { file: relFile(root, sf.fileName), line: a.line + 1, col: a.character + 1, endLine: b.line + 1, endCol: b.character + 1 };
}

/** Thrown after a diagnostic was recorded, to abandon the statement being built. */
export class Fail extends Error {
  constructor() {
    super("abfc frontend: statement abandoned");
  }
}

export class DiagSink {
  readonly diagnostics: Diagnostic[] = [];
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  report(severity: "error" | "warning", code: string, message: string, node?: ts.Node): void {
    const d: Diagnostic = { severity, code, message };
    if (node !== undefined) d.span = spanOf(node, this.root);
    this.diagnostics.push(d);
  }

  error(code: string, message: string, node?: ts.Node): void {
    this.report("error", code, message, node);
  }

  warning(code: string, message: string, node?: ts.Node): void {
    this.report("warning", code, message, node);
  }

  /** Records an error and abandons the current statement. */
  fail(code: string, message: string, node?: ts.Node): never {
    this.report("error", code, message, node);
    throw new Fail();
  }
}
