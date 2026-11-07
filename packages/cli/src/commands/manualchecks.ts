import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestCase } from "@abfc/ir";

/** Text of `.abfc/reports/manual-checks.md`: every `test.liveHud` case with its numbered checklist. */
export function manualChecksReport(mod: string, cases: readonly TestCase[]): string {
  const lines = [
    `# Manual checks for ${mod}`,
    "",
    "These tests need the live HUD, which hidden test runs do not have. abfc skipped them.",
    "Run in Play In Editor with the mod enabled; tick each item.",
    "",
  ];
  for (const c of cases) {
    lines.push(`## ${c.name}`, "", `Declared at \`${c.file}:${c.span.line}\`.`, "");
    (c.liveHud?.checklist ?? []).forEach((item, i) => lines.push(`${i + 1}. [ ] ${item}`));
    lines.push("");
  }
  return lines.join("\n");
}

/** Writes the report to `<projectDir>/.abfc/reports/manual-checks.md` and returns its project-relative path. */
export function writeManualChecks(projectDir: string, mod: string, cases: readonly TestCase[]): string {
  const rel = ".abfc/reports/manual-checks.md";
  mkdirSync(join(projectDir, ".abfc", "reports"), { recursive: true });
  writeFileSync(join(projectDir, ".abfc", "reports", "manual-checks.md"), manualChecksReport(mod, cases), "utf8");
  return rel;
}
