import { applyPlan, nodeKey } from "@abfc/backend";
import type { AssetApplyOutcome } from "@abfc/backend";
import {
  fingerprintUnit,
  mapCompileMessages,
  planBuild,
  readManifest,
  readSourceMap,
  writeManifest,
  writeSourceMap,
} from "@abfc/compiler";
import type { Manifest, ManifestUnit, SourceMapFile } from "@abfc/compiler";
import { parseExport, sha256 } from "@abfc/ir";
import type { AssetPlan, Diagnostic, IrAsset, T3dNode } from "@abfc/ir";
import type { CliContext } from "../context.js";
import {
  BackendSession,
  COMPILER_ID,
  Recorder,
  compileFrontend,
  countUnits,
  emitAll,
  hasError,
  lockDiagnostics,
  readAsset,
  since,
} from "./common.js";
import { ensureStage } from "./stage.js";

/** real node name -> `<unit id>/<IR node id>` */
function invert(nodeIds: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, real] of Object.entries(nodeIds)) out[real] = key;
  return out;
}

/** Source map of one asset: spans from the IR, real names from `names` (`<unit id>/<IR node id>` -> real). */
function sourceMapOf(asset: IrAsset, names: Record<string, string>): SourceMapFile {
  const units: SourceMapFile["units"] = {};
  for (const u of asset.units) {
    const nodes: SourceMapFile["units"][string]["nodes"] = {};
    for (const n of u.nodes) nodes[n.id] = { span: n.origin, real: names[nodeKey(u, n.id)] ?? null };
    units[u.id] = { span: u.origin, nodes };
  }
  return { asset: asset.path, units };
}

/** Names recorded by earlier builds for units this build did not touch. */
function previousNames(manifest: Manifest | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const u of manifest?.units ?? []) {
    for (const [irId, real] of Object.entries(u.nodeIds)) out[`${u.id}/${irId}`] = real;
  }
  return out;
}

function errorDiagnostics(
  asset: AssetPlan,
  irAsset: IrAsset,
  outcome: AssetApplyOutcome,
): Diagnostic[] {
  const sm = sourceMapOf(irAsset, outcome.nodeIds);
  return mapCompileMessages(asset.asset, outcome.compile, sm, invert(outcome.nodeIds));
}

/**
 * The build logic shared by `abfc build`, `abfc test` and `abfc publish`. Returns true when the stage holds the compiled
 * units (or already did) and Unreal compiled them without errors.
 */
export async function runBuild(ctx: CliContext, session: BackendSession, rec: Recorder): Promise<boolean> {
  const t0 = performance.now();
  let ok = false;
  try {
    ok = await buildInner(ctx, session, rec);
    return ok;
  } finally {
    rec.record("build.total", since(t0), ok);
  }
}

async function buildInner(ctx: CliContext, session: BackendSession, rec: Recorder): Promise<boolean> {
  const { output, config, env, args, projectDir, paths } = ctx;
  const mod = config.mod.name;
  const profile = env.profile;

  if (emitAll(ctx, lockDiagnostics(ctx, "build"))) return false;

  const tFront = performance.now();
  const fe = compileFrontend(ctx);
  rec.record("build.frontend", since(tFront), fe.ir !== null, fe.ir === null ? 0 : countUnits(fe.ir));
  if (fe.ir === null) return false;
  const ir = fe.ir;
  const owned = ir.assets.filter((a) => a.units.length > 0);

  const { backend, info } = await session.open();
  const caps = info.capabilities;

  const tStage = performance.now();
  const stage = await ensureStage(backend, env, config, { resync: args.flags.resync });
  rec.record("build.stage", since(tStage));

  const tRead = performance.now();
  const manifests = new Map<string, Manifest | null>();
  const snapshots = new Map<string, Map<string, T3dNode>>();
  const snapshotVariables = new Map<string, string[]>();
  for (const a of owned) {
    const { parsed } = await readAsset(ctx, backend, a.path);
    snapshots.set(a.path, parsed.nodes);
    snapshotVariables.set(a.path, parsed.variables.map((v) => v.name));
    manifests.set(a.path, readManifest(projectDir, a.path));
  }
  rec.record("build.read", since(tRead), true, owned.length);

  const planned = planBuild(ir, {
    manifests,
    snapshots,
    stage,
    handMadeUnits: new Map(fe.hir.classes.map((c) => [c.path, c.manualUnits])),
    snapshotVariables,
  });
  if (emitAll(ctx, planned.diagnostics)) return false;

  if (planned.plan.assets.length === 0) {
    output.info(`up to date (${planned.upToDate.length} unit(s) unchanged)`);
    output.json({ applied: [], upToDate: planned.upToDate });
    return true;
  }

  let route: "native" | "fallback" = "native";
  const applied = await applyPlan(backend, planned.plan, caps, profile, {
    cacheDir: paths.cacheDir,
    record: (step, seconds) => {
      if (step === "apply.phaseA") route = "fallback";
      rec.record(step, seconds);
    },
  });

  const irByPath = new Map(ir.assets.map((a) => [a.path, a]));
  if (!applied.ok) {
    let reported = 0;
    planned.plan.assets.forEach((a, i) => {
      const outcome = applied.perAsset[i];
      const irAsset = irByPath.get(a.asset);
      if (outcome === undefined || irAsset === undefined) return;
      for (const d of errorDiagnostics(a, irAsset, outcome)) {
        output.diag(d);
        reported++;
      }
    });
    if (reported === 0) {
      output.diag({
        severity: "error",
        code: "ABFC4002",
        message: "bp_apply failed and reported no compile message; the stage was rolled back.",
        fix: "run abfc build --verbose, or check the run folder named in the backend log.",
      });
    }
    return false;
  }

  // Success: record the manifest and the source map of every touched asset.
  const stagedUnits: string[] = [];
  const appliedAssets: string[] = [];
  for (let i = 0; i < planned.plan.assets.length; i++) {
    const a = planned.plan.assets[i]!;
    const outcome = applied.perAsset[i]!;
    const irAsset = irByPath.get(a.asset)!;
    if (outcome.tagWarning) output.diag(outcome.tagWarning);
    const nodes = parseExport(outcome.finalText ?? (await readAsset(ctx, backend, a.asset)).text).nodes;

    const old = manifests.get(a.asset) ?? null;
    const units: ManifestUnit[] = [...(old?.units ?? [])];
    for (const p of a.units) {
      const nodeIds: Record<string, string> = {};
      for (const n of p.unit.nodes) {
        const real = outcome.nodeIds[nodeKey(p.unit, n.id)];
        if (real !== undefined) nodeIds[n.id] = real;
      }
      const names = Object.values(nodeIds);
      const fp = fingerprintUnit(nodes, names);
      const next: ManifestUnit = {
        id: p.unit.id,
        graph: p.unit.graph,
        irHash: p.unit.hash,
        assetHash: fp.assetHash,
        nodes: names,
        nodeIds,
        tag: outcome.tagNames[p.unit.id] ?? null,
        stageSyncedAt: stage.syncedAt,
        adopt: units.find((u) => u.id === p.unit.id)?.adopt ?? null,
        nodeHashes: fp.nodeHashes,
        links: fp.links,
      };
      const at = units.findIndex((u) => u.id === p.unit.id);
      if (at >= 0) units[at] = next;
      else units.push(next);
      stagedUnits.push(`${p.unit.name}`);
    }
    const variables = [...(old?.variables ?? [])];
    for (const v of a.variables) {
      const entry = { name: v.name, type: v.type, hash: sha256(`${v.name}:${v.type}:${v.flags.join(",")}`) };
      const at = variables.findIndex((x) => x.name === v.name);
      if (at >= 0) variables[at] = entry;
      else variables.push(entry);
    }
    writeManifest(projectDir, { asset: a.asset, compiler: COMPILER_ID, profile: profile.id, units, variables });
    writeSourceMap(projectDir, sourceMapOf(irAsset, { ...previousNames(old), ...outcome.nodeIds }));
    appliedAssets.push(a.asset);
  }

  // Unreal's own compile of the changed assets.
  const tCompile = performance.now();
  const report = await backend.compile(mod, appliedAssets);
  const compileOk = report.clean || !report.messages.some((m) => m.severity === "error");
  rec.record("build.compile", since(tCompile), compileOk);
  if (!compileOk) {
    for (const asset of appliedAssets) {
      const sm = readSourceMap(projectDir, asset);
      if (sm === null) continue;
      const messages = report.messages.filter((m) => m.severity === "error");
      const names: Record<string, string> = {};
      for (const [unitId, u] of Object.entries(sm.units)) {
        for (const [irId, n] of Object.entries(u.nodes)) if (n.real !== null) names[n.real] = `${unitId}/${irId}`;
      }
      for (const d of mapCompileMessages(asset, messages, sm, names)) output.diag(d);
    }
    if (!hasError(output.diagnostics)) {
      output.diag({ severity: "error", code: "ABFC6002", message: "[Unreal] the compile report lists errors that could not be mapped." });
    }
    return false;
  }
  for (const m of report.messages) if (m.severity === "warning" && args.flags.verbose) output.info(`[Unreal warning] ${m.message}`);

  output.info(`applied ${stagedUnits.join(", ")} in ${appliedAssets.join(", ")} (route: ${route})`);
  output.json({ applied: stagedUnits, assets: appliedAssets, route, upToDate: planned.upToDate });
  return true;
}

/** `abfc build`. */
export async function build(ctx: CliContext): Promise<number> {
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  try {
    await runBuild(ctx, session, rec);
  } finally {
    await session.close();
    rec.print();
  }
  return ctx.output.exitCode();
}
