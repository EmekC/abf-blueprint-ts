// Pieces shared by check, build, test, status, adopt and publish: timings, lock check, frontend, backend session.
import { win32 } from "node:path";
import type { Backend } from "@abfc/backend";
import { buildHir, loadProgram, lowerChecked } from "@abfc/compiler";
import type { HirProgram, LoadedProgram } from "@abfc/compiler";
import { AbfcError } from "@abfc/env";
import { parseExport } from "@abfc/ir";
import type { BackendInfo, Diagnostic, IrModule, T3dExport } from "@abfc/ir";
import { checkLock, readLock } from "@abfc/stubgen";
import type { CliContext } from "../context.js";
import { backendInfoDiagnostics } from "./backend-version.js";
import { formatTimings, recordRun } from "../runs.js";
import type { RunEntry } from "../runs.js";

export const COMPILER_ID = "abfc 0.1.0";

/** Seconds since `t0` (a `performance.now()` value). */
export const since = (t0: number): number => (performance.now() - t0) / 1000;

/** Writes timings to `.abfc/runs.jsonl` and keeps them for `--timings`. */
export class Recorder {
  readonly entries: RunEntry[] = [];
  /** Says whether the backend ran its last commandlet operation on the warm session (set by {@link BackendSession}). */
  warmSource: (() => boolean) | null = null;
  constructor(private readonly ctx: CliContext) {}

  record(step: string, seconds: number, ok = true, units?: number): void {
    const entry: RunEntry = {
      at: this.ctx.deps.now().toISOString(),
      step,
      seconds,
      ok,
      mode: this.warmSource?.() === true ? "warm" : "cold",
    };
    if (units !== undefined) entry.units = units;
    this.entries.push(entry);
    recordRun(this.ctx.paths.runsFile, entry);
  }

  /** Prints the table of this invocation when `--timings` was given. */
  print(): void {
    if (!this.ctx.args.flags.timings) return;
    for (const line of formatTimings(this.entries)) this.ctx.output.info(line);
  }
}

export const hasError = (ds: Diagnostic[]): boolean => ds.some((d) => d.severity === "error");

/** Prints the diagnostics and says whether one of them is an error. */
export function emitAll(ctx: CliContext, ds: Diagnostic[]): boolean {
  for (const d of ds) ctx.output.diag(d);
  return hasError(ds);
}

export const hasErrors = (ctx: CliContext): boolean => hasError(ctx.output.diagnostics);

/** Fingerprint and coverage check of the stubs (`mode` decides the severity of ABFC3001). */
export function lockDiagnostics(ctx: CliContext, mode: "check" | "build"): Diagnostic[] {
  const lock = readLock(win32.join(ctx.paths.stubsDir, ctx.env.profile.id));
  return checkLock(lock, ctx.env, ctx.config, mode);
}

export interface Frontend {
  loaded: LoadedProgram;
  hir: HirProgram;
  /** null when the frontend reported errors. */
  ir: IrModule | null;
}

/** TypeScript program -> HIR -> IR, printing every diagnostic. */
export function compileFrontend(ctx: CliContext): Frontend {
  const loaded = loadProgram(ctx.projectDir);
  const hir = buildHir(loaded, { mod: ctx.config.mod.name }, ctx.env.profile);
  const diags = [...loaded.diagnostics, ...hir.diagnostics];
  emitAll(ctx, diags);
  if (hasError(diags)) return { loaded, hir, ir: null };
  const lowered = lowerChecked(hir, ctx.env.profile);
  for (const d of lowered.diagnostics) ctx.output.diag(d);
  return { loaded, hir, ir: lowered.ir };
}

export function countUnits(ir: IrModule): number {
  return ir.assets.reduce((n, a) => n + a.units.length, 0);
}

/** Problems of the backend's `backend_info`: warnings ABFC4012 (none) and ABFC4014 (older than the minimum), error ABFC4001 (protocol too old, thrown). */
function checkProtocol(ctx: CliContext, info: BackendInfo): void {
  const { config, env, output } = ctx;
  for (const d of backendInfoDiagnostics(info, config.backend.minProtocol, env.backendDir.value ?? "?")) {
    if (d.severity === "error") throw new AbfcError(d);
    output.diag(d);
  }
}

/** One backend per command run, started on first use. */
export class BackendSession {
  private opened: { backend: Backend; info: BackendInfo } | null = null;
  constructor(
    private readonly ctx: CliContext,
    private readonly rec: Recorder,
  ) {}

  async open(step = "build.backendStart"): Promise<{ backend: Backend; info: BackendInfo }> {
    if (this.opened !== null) return this.opened;
    const t0 = performance.now();
    const backend = await this.ctx.deps.startBackend(this.ctx.env, { cold: this.ctx.args.flags.cold });
    this.rec.warmSource = () => backend.lastWarm === true;
    try {
      const info = await backend.info();
      checkProtocol(this.ctx, info);
      this.opened = { backend, info };
    } catch (e) {
      this.rec.record(step, since(t0), false);
      try {
        await backend.close();
      } catch {
        // the backend is gone already
      }
      throw e;
    }
    this.rec.record(step, since(t0));
    return this.opened;
  }

  async close(): Promise<void> {
    const o = this.opened;
    this.opened = null;
    if (o === null) return;
    try {
      await o.backend.close();
    } catch {
      // the backend is gone already
    }
  }
}

/**
 * The assets (package paths under `/<mod>/`) that have no file in the stage: `<stagingPath>\Content\<path under /<mod>/>.uasset`
 * does not exist. An empty `stagingPath` (a backend that does not report it) means nothing is judged missing.
 */
export function missingInStage(ctx: CliContext, stagingPath: string, assets: string[]): Set<string> {
  const out = new Set<string>();
  if (stagingPath === "") return out;
  const prefix = `/${ctx.config.mod.name}/`;
  for (const a of assets) {
    if (!a.startsWith(prefix)) continue;
    const file = win32.join(stagingPath, "Content", ...a.slice(prefix.length).split("/")) + ".uasset";
    if (!ctx.deps.host.exists(file)) out.add(a);
  }
  return out;
}

/** `bp_read` of an asset and the parsed export. */
export async function readAsset(ctx: CliContext, backend: Backend, asset: string): Promise<{ text: string; parsed: T3dExport }> {
  const snap = await backend.read(ctx.config.mod.name, asset);
  const text = ctx.deps.host.readFile(snap.exportPath);
  return { text, parsed: parseExport(text) };
}

export const shortHash = (h: string | null): string => (h === null || h === "" ? "-" : h.replace(/^sha256:/, "").slice(0, 8));
