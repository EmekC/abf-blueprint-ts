// The names-only class catalog of an editor build (`.abfc/stubs/<profile>/_catalog.json`): which game and engine types exist,
// without members. It drives the automatic stub set and the completion of classes that have no stub yet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AbfcError } from "@abfc/env";
import { sha256 } from "@abfc/ir";
import { IDENT_RE, moduleSpecifier, tsIdent } from "./names.js";
import { writeFileAtomic } from "./store.js";

export const CATALOG_FILE = "_catalog.json";

export interface CatalogGameClass {
  /** `/Game/a/b/BP_X.BP_X_C` */
  path: string;
  kind: string;
  parent: string | null;
  interface: boolean;
}

export interface CatalogScriptClass {
  /** `/Script/Pkg.Name` */
  path: string;
  parent: string | null;
  interface?: true;
  /** A Blueprint function library: `functions` lists its function names. */
  library?: true;
  functions?: string[];
}

export interface Catalog {
  version: 1;
  editorFingerprint: string;
  engineVersion: string | null;
  createdAt: string;
  game: CatalogGameClass[];
  scriptClasses: CatalogScriptClass[];
  scriptStructs: string[];
  scriptEnums: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function unknownFormat(): AbfcError {
  return new AbfcError({
    severity: "error",
    code: "ABFC4002",
    message: "the backend's catalog has an unknown format.",
    fix: "update abf-mod-editor-mcp to 2.6.0 or newer.",
  });
}

/** Validates the backend's `catalog.json` (version 1) and drops malformed rows. */
export function catalogFromBackend(raw: unknown, editorFingerprint: string, createdAt: string): Catalog {
  if (!isObject(raw) || raw.version !== 1) throw unknownFormat();
  if (!Array.isArray(raw.game) || !Array.isArray(raw.scriptClasses) || !Array.isArray(raw.scriptStructs) || !Array.isArray(raw.scriptEnums)) {
    throw unknownFormat();
  }
  const pathOf = (row: unknown, prefix: string): string | null =>
    isObject(row) && typeof row.path === "string" && row.path.startsWith(prefix) ? row.path : null;
  const game: CatalogGameClass[] = [];
  for (const row of raw.game) {
    const path = pathOf(row, "/Game/");
    if (path === null) continue;
    const r = row as Record<string, unknown>;
    game.push({
      path,
      kind: typeof r.kind === "string" ? r.kind : "Blueprint",
      parent: typeof r.parent === "string" ? r.parent : null,
      interface: r.interface === true,
    });
  }
  const scriptClasses: CatalogScriptClass[] = [];
  for (const row of raw.scriptClasses) {
    const path = pathOf(row, "/Script/");
    if (path === null) continue;
    const r = row as Record<string, unknown>;
    const entry: CatalogScriptClass = { path, parent: typeof r.parent === "string" ? r.parent : null };
    if (r.interface === true) entry.interface = true;
    if (r.library === true) {
      entry.library = true;
      entry.functions = Array.isArray(r.functions) ? r.functions.filter((f): f is string => typeof f === "string") : [];
    }
    scriptClasses.push(entry);
  }
  const names = (v: unknown[]): string[] => v.filter((x): x is string => typeof x === "string" && x.startsWith("/Script/"));
  return {
    version: 1,
    editorFingerprint,
    engineVersion: typeof raw.engineVersion === "string" ? raw.engineVersion : null,
    createdAt,
    game,
    scriptClasses,
    scriptStructs: names(raw.scriptStructs),
    scriptEnums: names(raw.scriptEnums),
  };
}

/** Writes the catalog as one line of JSON; returns the sha256 of the text. */
export function writeCatalog(profileDir: string, c: Catalog): string {
  const text = JSON.stringify(c);
  writeFileAtomic(join(profileDir, CATALOG_FILE), text);
  return sha256(text);
}

export function readCatalog(profileDir: string): { catalog: Catalog; sha256: string } | null {
  try {
    const text = readFileSync(join(profileDir, CATALOG_FILE), "utf8").replace(/^﻿/, "");
    const c = JSON.parse(text) as Catalog;
    if (!isObject(c) || c.version !== 1 || !Array.isArray(c.game) || !Array.isArray(c.scriptClasses) || !Array.isArray(c.scriptStructs) || !Array.isArray(c.scriptEnums)) {
      return null;
    }
    return { catalog: c, sha256: sha256(text) };
  } catch {
    return null;
  }
}

export type CatalogKind = "game" | "class" | "struct" | "enum";

export interface CatalogLookup {
  kindOf(path: string): CatalogKind | undefined;
  /** Sorted /Game class paths declared in the stub module `specifier` (`/Game/a/b/BP_X`). */
  gameClassesOf(specifier: string): string[];
  /** The path an import `{ name } from specifier` refers to; undefined when the catalog has no such name. */
  resolveImport(specifier: string, name: string): string | undefined;
  /** The paths a user argument (`--add`, quick fix) stands for: a known path, `/Script/Pkg.Name` by its TS name, or a /Game module. */
  resolveAdd(arg: string): string[];
}

export function catalogLookup(c: Catalog): CatalogLookup {
  const kinds = new Map<string, CatalogKind>();
  for (const g of c.game) kinds.set(g.path, "game");
  for (const s of c.scriptClasses) kinds.set(s.path, "class");
  for (const s of c.scriptStructs) if (!kinds.has(s)) kinds.set(s, "struct");
  for (const s of c.scriptEnums) if (!kinds.has(s)) kinds.set(s, "enum");
  const byModule = new Map<string, string[]>();
  for (const g of [...c.game].sort((a, b) => byText(a.path, b.path))) {
    const spec = moduleSpecifier(g.path);
    const list = byModule.get(spec);
    if (list === undefined) byModule.set(spec, [g.path]);
    else list.push(g.path);
  }
  const script = new Map<string, string>();
  const sorted = [...c.scriptClasses.map((s) => s.path).sort(byText), ...[...c.scriptStructs].sort(byText), ...[...c.scriptEnums].sort(byText)];
  for (const p of sorted) {
    const key = `${moduleSpecifier(p)}|${tsIdent(p)}`;
    if (!script.has(key)) script.set(key, p);
  }
  const gameClassesOf = (specifier: string): string[] => [...(byModule.get(specifier) ?? [])];
  const resolveImport = (specifier: string, name: string): string | undefined => {
    if (specifier.startsWith("/Script/")) return script.get(`${specifier}|${name}`);
    if (specifier.startsWith("/Game/")) return gameClassesOf(specifier).find((p) => tsIdent(p) === name);
    return undefined;
  };
  return {
    kindOf: (path) => kinds.get(path),
    gameClassesOf,
    resolveImport,
    resolveAdd(arg) {
      if (kinds.has(arg)) return [arg];
      if (arg.startsWith("/Script/") && arg.includes(".")) {
        const p = resolveImport(moduleSpecifier(arg), tsIdent(arg));
        return p === undefined ? [] : [p];
      }
      if (arg.startsWith("/Game/") && !arg.includes(".")) return gameClassesOf(arg);
      return [];
    },
  };
}

/** What completion reads (`_names.json`). */
export interface CompletionNames {
  version: 1;
  types: Array<{ name: string; module: string; path: string; kind: "class" | "struct" | "enum" }>;
  functions: Array<{ name: string; container: string; module: string }>;
}

export function completionNamesOf(c: Catalog): CompletionNames {
  const types: CompletionNames["types"] = [];
  const add = (path: string, kind: "class" | "struct" | "enum"): void => {
    const name = tsIdent(path);
    if (IDENT_RE.test(name)) types.push({ name, module: moduleSpecifier(path), path, kind });
  };
  for (const g of c.game) add(g.path, "class");
  for (const s of c.scriptClasses) add(s.path, "class");
  for (const s of c.scriptStructs) add(s, "struct");
  for (const s of c.scriptEnums) add(s, "enum");
  const functions: CompletionNames["functions"] = [];
  for (const s of c.scriptClasses) {
    if (s.library !== true) continue;
    for (const name of s.functions ?? []) {
      if (IDENT_RE.test(name)) functions.push({ name, container: tsIdent(s.path), module: moduleSpecifier(s.path) });
    }
  }
  const order = (a: { name: string; module: string }, b: { name: string; module: string }): number => byText(a.name, b.name) || byText(a.module, b.module);
  return { version: 1, types: types.sort(order), functions: functions.sort(order) };
}
