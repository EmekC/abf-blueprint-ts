// Completion: the compiler's abfc completions (overridable parent events, library functions) as LSP completion items.
import { CompletionItemKind, InsertTextFormat, MarkupKind } from "vscode-languageserver/node.js";
import type { CompletionItem, Position } from "vscode-languageserver/node.js";
import { completionsAt } from "@abfc/compiler";
import type { AbfcCompletion, TsSourceFile } from "@abfc/compiler";
import { offsetRange } from "./convert.js";
import type { ProjectState, Snapshot } from "./project.js";
import { pathKey } from "./uri.js";

/** One compiler completion as an LSP item: the typed word is replaced through `textEdit`, imports ride along as `additionalTextEdits`. */
export function toCompletionItem(sf: TsSourceFile, c: AbfcCompletion): CompletionItem {
  const item: CompletionItem = {
    label: c.label,
    kind: c.kind === "method" ? CompletionItemKind.Method : CompletionItemKind.Function,
    detail: c.detail,
    insertTextFormat: c.snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    textEdit: { range: offsetRange(sf, c.replace.start, c.replace.end), newText: c.insertText },
    filterText: c.filterText ?? c.label,
    sortText: c.sortText,
  };
  if (c.labelDescription !== undefined) item.labelDetails = { description: c.labelDescription };
  if (c.documentation !== undefined && c.documentation !== "") item.documentation = { kind: MarkupKind.PlainText, value: c.documentation };
  if (c.additionalEdits.length > 0) {
    item.additionalTextEdits = c.additionalEdits.map((e) => ({ range: offsetRange(sf, e.start, e.end), newText: e.newText }));
  }
  return item;
}

/** The completion items at `pos` of the open document `path`; empty when the document is not part of the snapshot. */
export function completionItemsAt(state: ProjectState, snap: Snapshot, path: string, pos: Position): CompletionItem[] {
  const sf = snap.byKey.get(pathKey(path));
  if (sf === undefined) return [];
  let offset: number;
  try {
    offset = sf.getPositionOfLineAndCharacter(pos.line, pos.character);
  } catch {
    return [];
  }
  return completionsAt(snap.loaded, sf.fileName, offset, state.libraryIndex()).map((c) => toCompletionItem(sf, c));
}
