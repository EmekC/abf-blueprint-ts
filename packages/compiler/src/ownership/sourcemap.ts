// Source map (design 8.5): IR node -> TS span and IR node -> real node name; maps Unreal compile messages back to TS.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Diagnostic, Span } from "@abfc/ir";
import { assetFileStem, stringifySorted } from "./manifest.js";

export interface SourceMapFile {
  asset: string;
  units: Record<string, { span: Span; nodes: Record<string, { span: Span; real: string | null }> }>;
}

/** The part of the backend's `CompileMessage` the mapper needs. */
export interface CompileMessageLike {
  asset: string | null;
  message: string;
  node?: string;
  graph?: string;
}

export function sourceMapPath(dir: string, asset: string): string {
  return join(dir, ".abfc", "sourcemap", `${assetFileStem(asset)}.json`);
}

/** Writes the source map and returns its file path. */
export function writeSourceMap(dir: string, sm: SourceMapFile): string {
  const file = sourceMapPath(dir, sm.asset);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringifySorted(sm), "utf8");
  return file;
}

/** Removes the source map file of an asset (no-op when there is none). */
export function deleteSourceMap(dir: string, asset: string): void {
  const file = sourceMapPath(dir, asset);
  if (existsSync(file)) rmSync(file);
}

export function readSourceMap(dir: string, asset: string): SourceMapFile | null {
  const file = sourceMapPath(dir, asset);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as SourceMapFile;
}

/**
 * Compile messages -> diagnostics. `nodeIds` maps a real node name to `<unit id>/<IR node id>` for the owned nodes of the
 * asset (names recorded in the source map's `real` fields are used as well).
 *
 * Messages without a usable node are located by their text: `[spec:<id>]` (an apply error about a planned node; `specIds` maps the
 * spec node id to `<unit id>/<IR node id>`) and `Could not find a function named "X"` (`ownCalls` lists the TS spans of the calls to
 * owned function X). Both give ABFC6001 at the call. When such a located error exists, the unlocated fallback errors of messages
 * that belong to no asset (the backend's raw apply error) are dropped, so one failure gives one located error.
 */
export function mapCompileMessages(
  asset: string,
  messages: CompileMessageLike[],
  sm: SourceMapFile,
  nodeIds: Record<string, string>,
  specIds: Record<string, string> = {},
  ownCalls: Record<string, Span[]> = {},
): Diagnostic[] {
  const byReal = new Map<string, { unit: string; node: string }>();
  for (const [unitId, u] of Object.entries(sm.units)) {
    for (const [irId, n] of Object.entries(u.nodes)) if (n.real !== null) byReal.set(n.real, { unit: unitId, node: irId });
  }
  for (const [real, key] of Object.entries(nodeIds)) {
    const slash = key.indexOf("/");
    if (slash > 0) byReal.set(real, { unit: key.slice(0, slash), node: key.slice(slash + 1) });
  }
  const unitIds = Object.keys(sm.units);
  const out: Diagnostic[] = [];
  const fallbackOfUnowned = new Set<Diagnostic>();
  let located = false;
  for (const m of messages) {
    if (m.asset !== null && m.asset !== asset) continue;
    if (m.node !== undefined) {
      const hit = byReal.get(m.node);
      const span = hit ? sm.units[hit.unit]?.nodes[hit.node]?.span : undefined;
      if (hit && span) {
        out.push({ severity: "error", code: "ABFC6001", message: `[Unreal] ${m.message}`, span, asset });
      } else {
        out.push({ severity: "error", code: "ABFC6002", message: `[Unreal] ${m.message} (${m.node}, hand-made)`, asset });
      }
      continue;
    }
    const specMatch = SPEC_PREFIX.exec(m.message);
    if (specMatch) {
      const key = specIds[specMatch[1]!];
      const slash = key === undefined ? -1 : key.indexOf("/");
      const span = key !== undefined && slash > 0 ? sm.units[key.slice(0, slash)]?.nodes[key.slice(slash + 1)]?.span : undefined;
      if (span) {
        out.push({ severity: "error", code: "ABFC6001", message: `[Unreal] ${m.message.replace(SPEC_PREFIX_ALL, "")}`, span, asset });
        located = true;
        continue;
      }
    }
    const fn = NO_FUNCTION.exec(m.message)?.[1];
    const calls = fn === undefined ? [] : (ownCalls[fn] ?? []);
    if (calls.length > 0) {
      for (const span of calls) out.push({ severity: "error", code: "ABFC6001", message: `[Unreal] ${m.message.replace(SPEC_PREFIX_ALL, "")}`, span, asset });
      located = true;
      continue;
    }
    const text = m.message.replace(SPEC_PREFIX_ALL, "");
    let d: Diagnostic;
    if (unitIds.length === 1) {
      d = { severity: "error", code: "ABFC6002", message: `[Unreal] ${text} (node not identified)`, span: sm.units[unitIds[0]!]!.span, asset };
    } else {
      d = { severity: "error", code: "ABFC6002", message: `[Unreal] ${text}`, asset };
    }
    out.push(d);
    if (m.asset === null) fallbackOfUnowned.add(d);
  }
  return located && fallbackOfUnowned.size > 0 ? out.filter((d) => !fallbackOfUnowned.has(d)) : out;
}

const SPEC_PREFIX = /\[spec:([A-Za-z0-9_]+)\]/;
const SPEC_PREFIX_ALL = /\[spec:[A-Za-z0-9_]+\]\s*/g;
const NO_FUNCTION = /Could not find a function named "([^"]+)"/;
