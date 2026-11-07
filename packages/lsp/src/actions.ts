// Quick fixes, built from the server's own diagnostics for the requested range.
import { CodeActionKind } from "vscode-languageserver/node.js";
import type { CodeAction, Range } from "vscode-languageserver/node.js";
import { directorFix, idivFix, keepPathFix, modImportFix, optionalChainFix, relativePathFix, removePathFix } from "@abfc/compiler";
import type { CompilerProjectConfig, TextEdit, TsSourceFile } from "@abfc/compiler";
import type { Diagnostic } from "@abfc/ir";
import { offsetRange, spanOffsets, toLspDiagnostic } from "./convert.js";
import type { ProjectState, Snapshot } from "./project.js";
import { pathKey } from "./uri.js";

/** TypeScript's "possibly null / undefined" errors, which `?.` fixes. */
const TS_NULL = /^\[TS(2531|2532|18047|18048|18049)\]/;

interface Fix {
  title: string;
  edits: TextEdit[] | undefined;
}

function fixFor(d: Diagnostic, sf: TsSourceFile, start: number, end: number, cfg: CompilerProjectConfig): Fix | undefined {
  switch (d.code) {
    case "ABFC2010":
      return { title: "Use idiv(a, b) (Blueprint Divide_IntInt)", edits: idivFix(sf, start, end) };
    case "ABFC2006":
      return { title: "Remove the redundant path:", edits: removePathFix(sf, start, end) };
    case "ABFC2005":
      return { title: "Write path: relative to the mod", edits: relativePathFix(sf, start, end, cfg.mod) };
    case "ABFC2008":
      return { title: "Import from @mod/", edits: modImportFix(sf, start, end, cfg.mod) };
    case "ABFC2076":
      return { title: "Replace classManagerRow with @director", edits: directorFix(sf, start, end, cfg.mod, cfg.classManagerTable ?? "DataTables/DT_ClassManager") };
    case "ABFC5012": {
      const keepPath = (d.data as { keepPath?: unknown } | undefined)?.keepPath;
      if (typeof keepPath !== "string") return undefined;
      return { title: `Keep the existing asset path (path: "${keepPath}")`, edits: keepPathFix(sf, start, keepPath) };
    }
    case "ABFC2000":
      return TS_NULL.test(d.message) ? { title: "Use ?. (lowers to IsValid + Branch)", edits: optionalChainFix(sf, start, end) } : undefined;
    default:
      return undefined;
  }
}

/**
 * The quick fixes for the diagnostics of `path` that overlap `range` (ends inclusive). They come from the snapshot's own
 * diagnostics, so they do not depend on what the client sends back; TypeScript's possibly-null errors count even when
 * they are not published.
 */
export function codeActionsFor(state: ProjectState, snap: Snapshot, uri: string, path: string, range: Range, cfg: CompilerProjectConfig): CodeAction[] {
  const sf = snap.byKey.get(pathKey(path));
  if (sf === undefined) return [];
  let rangeStart: number;
  let rangeEnd: number;
  try {
    rangeStart = sf.getPositionOfLineAndCharacter(range.start.line, range.start.character);
    rangeEnd = sf.getPositionOfLineAndCharacter(range.end.line, range.end.character);
  } catch {
    return [];
  }
  const candidates = [...state.abfcDiagnosticsOf(snap, sf), ...state.tsDiagnosticsOf(snap, sf).filter((d) => TS_NULL.test(d.message))];
  const out: CodeAction[] = [];
  const seen = new Set<string>();
  for (const d of candidates) {
    if (d.span === undefined) continue;
    let offsets: { start: number; end: number };
    try {
      offsets = spanOffsets(sf, d.span);
    } catch {
      continue;
    }
    if (offsets.start > rangeEnd || rangeStart > offsets.end) continue;
    const fix = fixFor(d, sf, offsets.start, offsets.end, cfg);
    if (fix === undefined || fix.edits === undefined || fix.edits.length === 0) continue;
    const edits = fix.edits.map((e) => ({ range: offsetRange(sf, e.start, e.start + e.length), newText: e.newText }));
    const key = fix.title + "\n" + JSON.stringify(edits);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: fix.title,
      kind: CodeActionKind.QuickFix,
      isPreferred: true,
      diagnostics: [toLspDiagnostic(d)],
      edit: { changes: { [uri]: edits } },
    });
  }
  return out;
}
