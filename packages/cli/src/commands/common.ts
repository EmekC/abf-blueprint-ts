// Pieces shared by check, build, test, status, adopt and publish: timings, lock check, frontend, backend session.
import { win32 } from "node:path";
import type { Backend } from "@abfc/backend";
import { buildHir, compileTests, loadProgram, lower } from "@abfc/compiler";
import type { HirProgram, LoadedProgram } from "@abfc/compiler";
import { AbfcError, envWarning } from "@abfc/env";
import { parseExport, validateIrModule } from "@abfc/ir";
import type { BackendInfo, Diagnostic, IrModule, T3dExport } from "@abfc/ir";
import { checkLock, readLock } from "@abfc/stubgen";
import type { CliContext } from "../context.js";
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
  const ir = lower(hir, ctx.env.profile);
  const problems = validateIrModule(ir);
  for (const p of problems) {
    const unit = ir.assets.flatMap((a) => a.units.map((u) => ({ key: `${a.path} ${u.id}: `, u }))).find((x) => p.startsWith(x.key));
    ctx.output.diag({
      severity: "error",
      code: "ABFC2099",
      message: `internal: ${p}`,
      ...(unit ? { span: unit.u.origin } : {}),
    });
  }
  return { loaded, hir, ir: problems.length > 0 ? null : ir };
}

export function countUnits(ir: IrModule): number {
  return ir.assets.reduce((n, a) => n + a.units.length, 0);
}

/** Problems of the backend's `backend_info`: warning ABFC4012 (none), error ABFC4001 (protocol too old, thrown). */
function checkProtocol(ctx: CliContext, info: BackendInfo): void {
  const { config, env, output } = ctx;
  if (info.protocol === null) {
    output.diag(
      envWarning(
        4012,
        `the backend at ${env.backendDir.value ?? "?"} (server ${info.serverVersion}) has no backend_info tool (older abf-mod-editor-mcp).`,
        [],
        "update the backend to a version with backend_info; until then wildcard pins use the two-phase fallback.",
      ),
    );
  } else if (info.protocol < config.backend.minProtocol) {
    throw new AbfcError({
      severity: "error",
      code: "ABFC4001",
      message:
        `abf-mod-editor-mcp at ${env.backendDir.value ?? "?"} (server ${info.serverVersion}) reports protocol ${info.protocol}; ` +
        `abfc needs protocol >= ${config.backend.minProtocol}. Update it (see docs/backend.md).`,
      fix: "update the abf-mod-editor-mcp checkout.",
    });
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

/** `bp_read` of an asset and the parsed export. */
export async function readAsset(ctx: CliContext, backend: Backend, asset: string): Promise<{ text: string; parsed: T3dExport }> {
  const snap = await backend.read(ctx.config.mod.name, asset);
  const text = ctx.deps.host.readFile(snap.exportPath);
  return { text, parsed: parseExport(text) };
}

export const shortHash = (h: string | null): string => (h === null || h === "" ? "-" : h.replace(/^sha256:/, "").slice(0, 8));
