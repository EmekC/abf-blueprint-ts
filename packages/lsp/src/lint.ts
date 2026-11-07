// The @abfc/eslint-plugin recommended rules, run in-process with ESLint's Linter over the server's own ts.Program.
import { Linter } from "eslint";
import * as tsParser from "@typescript-eslint/parser";
import abfc from "@abfc/eslint-plugin";
import type { LoadedProgram, TsSourceFile } from "@abfc/compiler";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import type { Diagnostic as LspDiagnostic } from "vscode-languageserver/node.js";
import { LINT_DOC_URL } from "./convert.js";

const RULE_PREFIX = "abfc/";

export class ProjectLinter {
  private readonly linter: Linter;
  private readonly reported = new Set<string>();

  constructor(
    projectDir: string,
    /** Where a failure is reported (once per distinct message). */
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    this.linter = new Linter({ cwd: projectDir });
  }

  /** Lint findings of `sf` (a non-declaration file of `loaded.program`). A failure of ESLint is reported once and gives no findings. */
  lint(loaded: LoadedProgram, sf: TsSourceFile): LspDiagnostic[] {
    if (sf.fileName.endsWith(".d.ts")) return [];
    try {
      const messages = this.linter.verify(
        sf.text,
        [
          {
            files: ["**/*.ts"],
            languageOptions: {
              parser: tsParser,
              parserOptions: { programs: [loaded.program] },
            },
            plugins: { abfc: abfc as never },
            rules: abfc.configs.recommended.rules,
          },
        ],
        { filename: sf.fileName },
      );
      const out: LspDiagnostic[] = [];
      for (const m of messages) {
        if (m.fatal === true || m.ruleId === null || m.ruleId === undefined) {
          if (m.fatal === true) this.report(`lint of ${sf.fileName}: ${m.message}`);
          continue;
        }
        const line = Math.max(0, m.line - 1);
        const character = Math.max(0, m.column - 1);
        out.push({
          range: {
            start: { line, character },
            end: { line: Math.max(0, (m.endLine ?? m.line) - 1), character: Math.max(0, (m.endColumn ?? m.column) - 1) },
          },
          severity: m.severity === 2 ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
          code: m.ruleId,
          source: "abfc",
          message: m.message,
          codeDescription: { href: `${LINT_DOC_URL}#${m.ruleId.startsWith(RULE_PREFIX) ? m.ruleId.slice(RULE_PREFIX.length) : m.ruleId}` },
        });
      }
      return out;
    } catch (e) {
      this.report(`lint of ${sf.fileName} failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  private report(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.onError(message);
  }
}
