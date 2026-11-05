// Source map (design 8.5): IR node -> TS span and IR node -> real node name; maps Unreal compile messages back to TS.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function readSourceMap(dir: string, asset: string): SourceMapFile | null {
  const file = sourceMapPath(dir, asset);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as SourceMapFile;
}

/**
 * Compile messages -> diagnostics. `nodeIds` maps a real node name to `<unit id>/<IR node id>` for the owned nodes of the
 * asset (names recorded in the source map's `real` fields are used as well).
 */
export function mapCompileMessages(
  asset: string,
  messages: CompileMessageLike[],
  sm: SourceMapFile,
  nodeIds: Record<string, string>,
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
    } else if (unitIds.length === 1) {
      out.push({
        severity: "error",
        code: "ABFC6002",
        message: `[Unreal] ${m.message} (node not identified)`,
        span: sm.units[unitIds[0]!]!.span,
        asset,
      });
    } else {
      out.push({ severity: "error", code: "ABFC6002", message: `[Unreal] ${m.message}`, asset });
    }
  }
  return out;
}
