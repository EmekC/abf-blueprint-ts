import { applyPlan, nodeKey, specNodeId } from "@abfc/backend";
import type { AssetApplyOutcome } from "@abfc/backend";
import {
  assetsNeedingRead,
  fingerprintUnit,
  mapCompileMessages,
  planBuild,
  readManifest,
  readSourceMap,
  rebaseStaleUnits,
  writeManifest,
  writeRetired,
  writeSourceMap,
} from "@abfc/compiler";
import type { Manifest, ManifestUnit, SourceMapFile } from "@abfc/compiler";
import { parseExport, sha256 } from "@abfc/ir";
import type { AssetPlan, Diagnostic, IrAsset, IrModule, Span, T3dNode } from "@abfc/ir";
import { readLock } from "@abfc/stubgen";
import { win32 } from "node:path";
import type { CliContext } from "../context.js";
import { readUnitCache, stubLockHashOf, writeUnitCache } from "../unitcache.js";
import type { UnitCache } from "../unitcache.js";
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

/** Records every unit of the owned assets as built with the current compiler and stub lock (read by the next build). */
function writeCache(ctx: CliContext, owned: IrAsset[], cache: UnitCache, stubLockHash: string): void {
  const next: UnitCache = { ...cache };
  for (const a of owned) {
    const units: UnitCache[string] = {};
    for (const u of a.units) units[u.id] = { irHash: u.hash, stubLockHash, compilerVersion: COMPILER_ID };
    next[a.path] = units;
  }
  writeUnitCache(win32.join(ctx.paths.cacheDir, "units.json"), next);
}

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

/** What maps an apply or compile message back to a call: spec node id -> `<unit id>/<IR node id>`, and the TS spans of calls to owned functions. */
function callMaps(asset: IrAsset): { specIds: Record<string, string>; ownCalls: Record<string, Span[]> } {
  const specIds: Record<string, string> = {};
  const ownCalls: Record<string, Span[]> = {};
  for (const u of asset.units) {
    for (const n of u.nodes) {
      specIds[specNodeId(u, n.id)] ??= nodeKey(u, n.id);
      if (n.sem?.k === "call" && n.sem.class === undefined) (ownCalls[n.sem.function] ??= []).push(n.origin);
    }
  }
  return { specIds, ownCalls };
}

function errorDiagnostics(
  asset: AssetPlan,
  irAsset: IrAsset,
  outcome: AssetApplyOutcome,
): Diagnostic[] {
  const sm = sourceMapOf(irAsset, outcome.nodeIds);
  const { specIds, ownCalls } = callMaps(irAsset);
  return mapCompileMessages(asset.asset, outcome.compile, sm, invert(outcome.nodeIds), specIds, ownCalls);
}

/**
 * The build logic shared by `abfc build`, `abfc test` and `abfc publish`. Returns true when the stage holds the compiled
 * units (or already did) and Unreal compiled them without errors. `readAll` reads every owned asset (the publish gate does this
 * so editor drift in an unchanged asset is found); by default assets with nothing to plan are not read.
 */
export async function runBuild(ctx: CliContext, session: BackendSession, rec: Recorder, opts: { readAll?: boolean } = {}): Promise<boolean> {
  const t0 = performance.now();
  let ok = false;
  try {
    ok = await buildInner(ctx, session, rec, opts.readAll === true);
    return ok;
  } finally {
    rec.record("build.total", since(t0), ok);
  }
}

async function buildInner(ctx: CliContext, session: BackendSession, rec: Recorder, readAll: boolean): Promise<boolean> {
  const { output, config, env, args, projectDir, paths } = ctx;
  const mod = config.mod.name;
  const profile = env.profile;

  if (emitAll(ctx, lockDiagnostics(ctx, "build"))) return false;

  const tFront = performance.now();
  const fe = compileFrontend(ctx);
  rec.record("build.frontend", since(tFront), fe.ir !== null, fe.ir === null ? 0 : countUnits(fe.ir));
  if (fe.ir === null) return false;
  const ir = fe.ir;
  const owned = ir.assets.filter((a) => a.units.length > 0 || a.classDefaults !== undefined || a.classManagerRow !== undefined);

  const { backend, info } = await session.open();
  const caps = info.capabilities;

  const tStage = performance.now();
  const stage = await ensureStage(backend, env, config, { resync: args.flags.resync });
  rec.record("build.stage", since(tStage));

  // Units built with another compiler or stub lock, or whose cached IR hash differs from the current one (an earlier build did not
  // finish: the cache is written last), are re-planned although the manifest's IR hash is equal.
  const stubLockHash = stubLockHashOf(readLock(win32.join(ctx.paths.stubsDir, profile.id)));
  const cache = readUnitCache(win32.join(ctx.paths.cacheDir, "units.json"));
  const forceReplan = new Set<string>();
  const manifests = new Map<string, Manifest | null>();
  for (const a of owned) {
    manifests.set(a.path, readManifest(projectDir, a.path));
    for (const u of a.units) {
      const c = cache[a.path]?.[u.id];
      if (c !== undefined && (c.stubLockHash !== stubLockHash || c.compilerVersion !== COMPILER_ID || c.irHash !== u.hash)) forceReplan.add(`${a.path} ${u.id}`);
    }
  }

  // Assets that cannot have anything to plan are not read (no drift check there; `abfc status` still reads everything), unless `readAll`.
  const tRead = performance.now();
  const toRead = readAll ? new Set(owned.map((a) => a.path)) : assetsNeedingRead({ ...ir, assets: owned }, { manifests, stage, forceReplan });
  const readAssets = owned.filter((a) => toRead.has(a.path));
  const skipped = owned.filter((a) => !toRead.has(a.path));
  const snapshots = new Map<string, Map<string, T3dNode>>();
  const snapshotVariables = new Map<string, string[]>();
  for (const a of readAssets) {
    const { parsed } = await readAsset(ctx, backend, a.path);
    snapshots.set(a.path, parsed.nodes);
    snapshotVariables.set(a.path, parsed.variables.map((v) => v.name));
  }
  rec.record("build.read", since(tRead), true, readAssets.length);

  // A stage re-synced from a published mod that holds the abfc-built graphs: record the new sync time in the manifests of those units.
  for (const a of readAssets) {
    const m = manifests.get(a.path) ?? null;
    const snap = snapshots.get(a.path);
    if (m === null || snap === undefined) continue;
    const rebased = rebaseStaleUnits(m, snap, stage);
    if (!rebased.changed) continue;
    manifests.set(a.path, rebased.manifest);
    writeManifest(projectDir, rebased.manifest);
  }

  const planIr: IrModule = { ...ir, assets: readAssets };
  const planned = planBuild(planIr, {
    manifests,
    snapshots,
    stage,
    handMadeUnits: new Map(fe.hir.classes.map((c) => [c.path, c.manualUnits])),
    snapshotVariables,
    forceReplan,
    selfEventCalls: caps.selfEventCalls,
  });
  if (emitAll(ctx, planned.diagnostics)) return false;
  for (const a of skipped) for (const u of a.units) planned.upToDate.push(`${a.path} ${u.id}`);

  if (planned.plan.assets.length === 0) {
    writeCache(ctx, owned, cache, stubLockHash);
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

  // Success: record the manifest and the source map of every touched asset. The manifest keeps what is on the stage (nodes, hashes)
  // but takes the IR hash of the applied units and the class defaults hash only after Unreal's compile passed: until then the
  // applied units count as changed, so a failed compile is repeated (and reported) by the next build instead of passing as up to date.
  const finals: Manifest[] = [];
  const stagedUnits: string[] = [];
  const appliedAssets: string[] = [];
  const removedUnits: string[] = [];
  let removedOrphanTags = 0;
  for (let i = 0; i < planned.plan.assets.length; i++) {
    const a = planned.plan.assets[i]!;
    const outcome = applied.perAsset[i]!;
    const irAsset = irByPath.get(a.asset)!;
    if (outcome.tagWarning) output.diag(outcome.tagWarning);
    for (const d of outcome.defaultsWarnings) output.diag(d);
    const nodes = parseExport(outcome.finalText ?? (await readAsset(ctx, backend, a.asset)).text).nodes;

    const old = manifests.get(a.asset) ?? null;
    // Units that left the TS are gone from the stage now (or were never there): drop them from the manifest. This is not held back
    // until Unreal's compile passes: a failed compile does not roll the removal back, and a manifest that still listed the removed
    // nodes would make the next build report them as missing (ABFC5002).
    const dropIds = new Set([...(a.removeUnits ?? []).map((r) => r.id), ...(a.forgetUnits ?? [])]);
    for (const r of a.removeUnits ?? []) removedUnits.push(r.id.slice(r.id.indexOf(":") + 1));
    // The stubs still list a removed event as a hand-made member: hide it until `abfc stubs` reads the stage again.
    // Only units whose nodes were really deleted: a forgotten unit (never applied, or adopted hand-made nodes) left them on the stage.
    const retired = (a.removeUnits ?? []).map((r) => r.id);
    writeRetired(win32.join(paths.stubsDir, profile.id), a.asset, retired);
    for (const r of a.removeTags ?? []) removedOrphanTags += r.nodes.length;
    const units: ManifestUnit[] = (old?.units ?? []).filter((u) => !dropIds.has(u.id));
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
    // Class defaults: the hash is recorded only when pass 5 succeeded, so a failed pass is repeated by the next build.
    const defaultsDone = a.defaults !== undefined && outcome.defaultsApplied;
    const classDefaultsHash = defaultsDone ? a.defaults!.hash : old?.classDefaultsHash;
    const classDefaultsStageSyncedAt = defaultsDone ? stage.syncedAt : old?.classDefaultsStageSyncedAt;
    const appliedIds = new Set(a.units.map((p) => p.unit.id));
    const finalManifest: Manifest = {
      asset: a.asset,
      compiler: COMPILER_ID,
      profile: profile.id,
      units,
      variables,
      ...(classDefaultsHash !== undefined ? { classDefaultsHash } : {}),
      ...(classDefaultsStageSyncedAt !== undefined ? { classDefaultsStageSyncedAt } : {}),
    };
    finals.push(finalManifest);
    writeManifest(projectDir, {
      asset: a.asset,
      compiler: COMPILER_ID,
      profile: profile.id,
      variables,
      units: units.map((u) => (appliedIds.has(u.id) ? { ...u, irHash: "" } : u)),
      ...(old?.classDefaultsHash !== undefined ? { classDefaultsHash: old.classDefaultsHash } : {}),
      ...(old?.classDefaultsStageSyncedAt !== undefined ? { classDefaultsStageSyncedAt: old.classDefaultsStageSyncedAt } : {}),
    });
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
      const irAsset = ir.assets.find((a) => a.path === asset);
      const { specIds, ownCalls } = irAsset ? callMaps(irAsset) : { specIds: {}, ownCalls: {} };
      for (const d of mapCompileMessages(asset, messages, sm, names, specIds, ownCalls)) output.diag(d);
    }
    if (!hasError(output.diagnostics)) {
      output.diag({ severity: "error", code: "ABFC6002", message: "[Unreal] the compile report lists errors that could not be mapped." });
    }
    return false;
  }
  for (const m of finals) writeManifest(projectDir, m);
  for (const m of report.messages) if (m.severity === "warning" && args.flags.verbose) output.info(`[Unreal warning] ${m.message}`);

  writeCache(ctx, owned, cache, stubLockHash);
  output.info(`applied ${stagedUnits.length > 0 ? stagedUnits.join(", ") : "no units"} in ${appliedAssets.join(", ")} (route: ${route})${removedUnits.length > 0 ? `, removed ${removedUnits.join(", ")}` : ""}${removedOrphanTags > 0 ? `, removed ${removedOrphanTags} orphan tag comment(s)` : ""}`);
  output.json({ applied: stagedUnits, assets: appliedAssets, route, upToDate: planned.upToDate, ...(removedUnits.length > 0 ? { removed: removedUnits } : {}), ...(removedOrphanTags > 0 ? { removedOrphanTags } : {}) });
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
