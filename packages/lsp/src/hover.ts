// Hover: the Blueprint nodes of the statement, a stub member's description, optionally the TypeScript type.
import { relative } from "node:path";
import type { Hover, Position } from "vscode-languageserver/node.js";
import { describeIrNode, irNodesAt, stubDescriptionAt, tsQuickInfoAt } from "@abfc/compiler";
import type { InitOptions, ProjectState, Snapshot } from "./project.js";
import { pathKey } from "./uri.js";

/** At most this many Blueprint nodes are listed; the rest is counted. */
export const MAX_HOVER_NODES = 6;

/** The hover at `pos` of the open document `path`, or null when there is nothing to say. */
export function hoverAt(state: ProjectState, snap: Snapshot, path: string, pos: Position, opts: InitOptions): Hover | null {
  const sf = snap.byKey.get(pathKey(path));
  if (sf === undefined) return null;
  let offset: number;
  try {
    offset = sf.getPositionOfLineAndCharacter(pos.line, pos.character);
  } catch {
    return null;
  }
  const parts: string[] = [];
  if (opts.tsHover === true) {
    const info = tsQuickInfoAt(snap.loaded, sf, offset);
    if (info !== undefined) parts.push("```typescript\n" + info + "\n```");
  }
  const description = stubDescriptionAt(snap.loaded, sf, offset);
  if (description !== undefined) parts.push(description);
  const ir = snap.check.ir;
  if (ir !== null) {
    const rel = relative(state.dir, sf.fileName).replaceAll("\\", "/");
    const names = [...new Set(irNodesAt(ir, rel, pos.line + 1, pos.character + 1).map(describeIrNode))];
    if (names.length > 0) {
      const more = names.length > MAX_HOVER_NODES ? ` (+${names.length - MAX_HOVER_NODES} more)` : "";
      parts.push(`Blueprint: ${names.slice(0, MAX_HOVER_NODES).join(" · ")}${more}`);
    }
  }
  if (parts.length === 0) return null;
  return { contents: { kind: "markdown", value: parts.join("\n\n") } };
}
