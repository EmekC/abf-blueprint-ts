// Quick fixes, built from the server's own diagnostics for the requested range.
import { CodeActionKind } from "vscode-languageserver/node.js";
import type { CodeAction, Range } from "vscode-languageserver/node.js";
import { addDirectorTagFix, directorFix, idivFix, keepPathFix, modImportFix, optionalChainFix, relativePathFix, removePathFix, stubImportAt, useOverrideFix } from "@abfc/compiler";
import type { CompilerProjectConfig, TextEdit, TsSourceFile } from "@abfc/compiler";
import type { Diagnostic } from "@abfc/ir";
import { offsetRange, spanOffsets, toLspDiagnostic } from "./convert.js";
import { GENERATE_STUBS_COMMAND } from "./generate.js";
import type { ProjectState, Snapshot } from "./project.js";
import { pathKey } from "./uri.js";

/** TypeScript's "possibly null / undefined" errors, which `?.` fixes. */
const TS_NULL = /^\[TS(2531|2532|18047|18048|18049)\]/;

/** TypeScript's "module / exported member not found" errors, which a missing stub causes. */
const TS_STUB_MISSING = /^\[TS(2305|2307|2614|2724)\]/;

/** What the "Generate stubs" quick fix needs besides the editor: the CLI is known and where the project lives. */
export interface ActionOptions {
  canGenerate: boolean;
  projectDir: string;
}

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
    case "ABFC2079": {
      const tag = (d.data as { tag?: unknown } | undefined)?.tag;
      if (typeof tag !== "string") return undefined;
      return { title: `Add the gameplay tag "${tag}"`, edits: addDirectorTagFix(sf, start, end, tag) };
    }
    case "ABFC2078":
      return { title: "Use @override", edits: useOverrideFix(sf, start, end) };
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
export function codeActionsFor(
  state: ProjectState,
  snap: Snapshot,
  uri: string,
  path: string,
  range: Range,
  cfg: CompilerProjectConfig,
  opts: ActionOptions = { canGenerate: false, projectDir: "" },
): CodeAction[] {
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
  if (opts.canGenerate) {
    for (const d of state.tsDiagnosticsOf(snap, sf)) {
      if (d.span === undefined || !TS_STUB_MISSING.test(d.message)) continue;
      let offsets: { start: number; end: number };
      try {
        offsets = spanOffsets(sf, d.span);
      } catch {
        continue;
      }
      if (offsets.start > rangeEnd || rangeStart > offsets.end) continue;
      const imp = stubImportAt(sf, offsets.start, offsets.end);
      if (imp === undefined) continue;
      const isScript = imp.specifier.startsWith("/Script/");
      const add = isScript ? imp.names.map((n) => `${imp.specifier}.${n}`) : [imp.specifier];
      if (add.length === 0) continue;
      const title = `Generate stubs for ${imp.names.length > 0 ? imp.names.join(", ") : imp.specifier}`;
      if (seen.has(title)) continue;
      seen.add(title);
      out.push({
        title,
        kind: CodeActionKind.QuickFix,
        diagnostics: [toLspDiagnostic(d)],
        command: { title, command: GENERATE_STUBS_COMMAND, arguments: [{ projectDir: opts.projectDir, add }] },
      });
    }
  }
  return out;
}
