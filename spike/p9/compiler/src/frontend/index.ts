// The only file in the compiler that imports "typescript" (frontend isolation seam).
import ts from "typescript";
import type { HirUnit } from "../hir.js";

export function checkSubset(_program: ts.Program, _file: ts.SourceFile): ts.Diagnostic[] {
  return [];
}

function hasEventDecorator(m: ts.MethodDeclaration): boolean {
  const decorators = ts.canHaveDecorators(m) ? ts.getDecorators(m) : undefined;
  return (decorators ?? []).some((d) => {
    const e = d.expression;
    return ts.isIdentifier(e) ? e.text === "event" : ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "event";
  });
}

export function toHir(program: ts.Program): HirUnit[] {
  const units: HirUnit[] = [];
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    ts.forEachChild(file, function visit(node) {
      if (ts.isClassDeclaration(node)) {
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && hasEventDecorator(member)) {
            const start = file.getLineAndCharacterOfPosition(member.getStart(file));
            const end = file.getLineAndCharacterOfPosition(member.getEnd());
            units.push({
              name: member.name.getText(file),
              nodes: [{ kind: "event", span: { file: file.fileName, line: start.line + 1, col: start.character + 1, endLine: end.line + 1, endCol: end.character + 1 } }],
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }
  return units;
}
