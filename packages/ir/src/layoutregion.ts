// Layout check for Widget Blueprints: everything in a T3D export except the graphs this tool owns. A graph-only publish
// must leave this region byte-for-byte identical (the WidgetTree and every hand-made property stay untouched).

const EDGRAPH_HEADER = /^ {3}Begin Object (?:Class=\/Script\/Engine\.EdGraph |Name="[^"]*" ExportPath="\/Script\/Engine\.EdGraph')/;
const GRAPH_LIST_PROPERTY = /^ {3}(?:UbergraphPages|FunctionGraphs|LastEditedDocuments)\(/;
const NEW_VARIABLE = /^ {3}NewVariables\(\d+\)=(.*)$/;
const VAR_NAME = /VarName="([^"]*)"/;
const COMPILER_TEMP = /^abfc_/;

/**
 * The part of an export that must not change when only owned graphs change: lines with the top-level EdGraph blocks, the
 * graph list properties and the NewVariables entries of `ownedVariables` (and compiler temps `abfc_*`) removed. The
 * remaining NewVariables lines lose their running index, so adding an owned variable does not renumber the others.
 * Sibling blocks are compared in header order unless `opts.sortSiblings` is false (raw export order, the strict mode).
 */
export function layoutRegion(exportText: string, ownedVariables: readonly string[] = [], opts: LayoutOptions = {}): string[] {
  const owned = new Set(ownedVariables);
  const out: string[] = [];
  const lines = exportText.replace(/\r\n/g, "\n").split("\n");
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k] ?? "";
    if (EDGRAPH_HEADER.test(line)) {
      while (k < lines.length && !/^ {3}End Object\b/.test(lines[k] ?? "")) k++;
      continue;
    }
    if (GRAPH_LIST_PROPERTY.test(line)) continue;
    const nv = NEW_VARIABLE.exec(line);
    if (nv) {
      const name = VAR_NAME.exec(nv[1] ?? "")?.[1];
      if (name !== undefined && (owned.has(name) || COMPILER_TEMP.test(name))) continue;
      out.push(`   NewVariables=${nv[1] ?? ""}`);
      continue;
    }
    out.push(line);
  }
  return opts.sortSiblings === false ? out : sortSiblingBlocks(out);
}

export interface LayoutOptions {
  /** Compare sibling WidgetTree blocks in header order (default true); false keeps the order of the export. */
  sortSiblings?: boolean;
}

const BLOCK_START = /^( *)Begin Object\b/;

/**
 * The editor writes sibling objects (widgets, slots) in memory order, which differs between a freshly loaded asset and one
 * reloaded from disk although nothing changed. Runs of consecutive sibling `Begin Object` blocks are therefore compared in
 * header order; property lines (including the ordered Slots/Children arrays) keep their position.
 */
function sortSiblingBlocks(lines: string[]): string[] {
  const out: string[] = [];
  let k = 0;
  while (k < lines.length) {
    const line = lines[k] ?? "";
    const start = BLOCK_START.exec(line);
    if (!start) {
      out.push(line);
      k++;
      continue;
    }
    const run: string[][] = [];
    while (k < lines.length) {
      const header = lines[k] ?? "";
      const s = BLOCK_START.exec(header);
      if (!s) break;
      const indent = s[1] ?? "";
      let end = k + 1;
      while (end < lines.length && !(lines[end] ?? "").startsWith(`${indent}End Object`)) end++;
      const body = sortSiblingBlocks(lines.slice(k + 1, end));
      run.push([header, ...body, lines[end] ?? ""]);
      k = end + 1;
    }
    run.sort((x, y) => ((x[0] ?? "") < (y[0] ?? "") ? -1 : (x[0] ?? "") > (y[0] ?? "") ? 1 : 0));
    for (const block of run) out.push(...block);
  }
  return out;
}

export interface LayoutDiff {
  equal: boolean;
  firstDiff?: { line: number; before: string; after: string };
  beforeLines: number;
  afterLines: number;
}

export function diffLayout(before: string, after: string, ownedVariables: readonly string[] = [], opts: LayoutOptions = {}): LayoutDiff {
  const a = layoutRegion(before, ownedVariables, opts);
  const b = layoutRegion(after, ownedVariables, opts);
  const n = Math.max(a.length, b.length);
  for (let k = 0; k < n; k++) {
    if (a[k] !== b[k]) {
      return { equal: false, firstDiff: { line: k + 1, before: a[k] ?? "", after: b[k] ?? "" }, beforeLines: a.length, afterLines: b.length };
    }
  }
  return { equal: true, beforeLines: a.length, afterLines: b.length };
}
