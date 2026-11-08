import { applyPlan, nodeKey, specNodeId } from "@abfc/backend";
import type { AssetApplyOutcome, Backend } from "@abfc/backend";
import {
  assetsNeedingRead,
  fingerprintUnit,
  listManifests,
  mapCompileMessages,
  featureGates,
  planBuild,
  readManifest,
  readSourceMap,
  rebaseStaleUnits,
  writeManifest,
  writeRetired,
  writeSourceMap,
} from "@abfc/compiler";
import type { Manifest, ManifestUnit, SourceMapFile } from "@abfc/compiler";
import { parseExport, sha256, structFieldsHash } from "@abfc/ir";
import type { AssetPlan, Diagnostic, IrAsset, IrModule, IrUnit, Span, T3dNode } from "@abfc/ir";
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
  missingInStage,
  previousNames,
  pruneManifestsToStage,
  readAsset,
  sourceMapOf,
  since,
} from "./common.js";
import { refreshTagsFile } from "../tags.js";
import { ensureStage } from "./stage.js";

/** True for an @event whose doc comment is its tooltip: the backend only writes it with the bp_apply feature `event_meta`. */
function hasEventTooltip(u: IrUnit): boolean {
  const entry = u.nodes.find((n) => n.sem?.k === "event");
  return entry?.sem?.k === "event" && entry.sem.meta !== undefined;
}

/** Records every unit of the owned assets as built with the current compiler and stub lock (read by the next build). */
function writeCache(ctx: CliContext, owned: IrAsset[], cache: UnitCache, stubLockHash: string, eventMeta: boolean): void {
  const next: UnitCache = { ...cache };
  for (const a of owned) {
    const units: UnitCache[string] = {};
    for (const u of a.units) units[u.id] = { irHash: u.hash, stubLockHash, compilerVersion: COMPILER_ID, ...(hasEventTooltip(u) ? { eventMeta } : {}) };
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
  // Where each asset comes from (recorded in its manifest, docs/design.md 18.2).
  const sources = new Map<string, NonNullable<Manifest["source"]>>();
  for (const c of [...fe.hir.classes, ...fe.hir.structs]) sources.set(c.path, { file: c.span.file, class: c.name, derived: c.pathDerived });
  // Mod-defined structs (UserDefinedStruct): created from the TS, never read; planned first.
  const structAssets = ir.assets.filter((a) => a.structFields !== undefined);
  const owned = ir.assets.filter((a) => a.units.length > 0 || a.classDefaults !== undefined || a.classManagerRow !== undefined || a.director !== undefined || a.variables.some((v) => v.temp !== true) || (a.director === undefined && readManifest(projectDir, a.path)?.directorRow !== undefined));
  // A class whose TypeScript is gone but whose manifest still lists units: its units are retired like those of a removed event.
  for (const m of listManifests(projectDir)) {
    if (!m.asset.startsWith(`/${mod}/`) || m.units.length === 0 || owned.some((a) => a.path === m.asset)) continue;
    owned.push(ir.assets.find((a) => a.path === m.asset) ?? { path: m.asset, variables: [], units: [] });
    if (m.classDefaultsHash !== undefined) {
      output.diag({
        severity: "warning",
        code: "ABFC5010",
        asset: m.asset,
        message: `${m.asset} is no longer declared in TypeScript; its owned units are removed, the class defaults abfc set stay as they are.`,
      });
    }
  }

  const { backend, info } = await session.open();
  const caps = info.capabilities;
  // Feature gates: Map/Set types and creatable kinds the backend (or abfc's native policy) lacks fail here, before the stage is touched.
  if (emitAll(ctx, featureGates({ ...ir, assets: [...structAssets, ...owned] }, caps))) return false;

  const tStage = performance.now();
  const { status: stage, resynced } = await ensureStage(backend, env, config, { resync: args.flags.resync, warn: (d) => output.diag(d) });
  // A stage copied from the mod again holds no unpublished work: the manifests follow before anything is planned from them.
  if (resynced) await pruneManifestsToStage(ctx, backend, mod, { ir, owned });
  rec.record("build.stage", since(tStage));
  // A class whose asset is not in the stage yet is created by the apply: it is not read, its manifest (if any) is ignored, every unit is planned.
  const missing = missingInStage(ctx, stage.stagingPath, [...structAssets, ...owned].filter((a) => a.create !== undefined).map((a) => a.path));

  // Units built with another compiler or stub lock, or whose cached IR hash differs from the current one (an earlier build did not
  // finish: the cache is written last), are re-planned although the manifest's IR hash is equal.
  const stubLockHash = stubLockHashOf(readLock(win32.join(ctx.paths.stubsDir, profile.id)));
  const cache = readUnitCache(win32.join(ctx.paths.cacheDir, "units.json"));
  const forceReplan = new Set<string>();
  const manifests = new Map<string, Manifest | null>();
  // A struct's manifest is read even when the stage lacks the file: its field hash guards against changing a created struct.
  for (const a of structAssets) manifests.set(a.path, readManifest(projectDir, a.path));
  for (const a of owned) {
    manifests.set(a.path, missing.has(a.path) ? null : readManifest(projectDir, a.path));
    for (const u of a.units) {
      const c = cache[a.path]?.[u.id];
      if (c !== undefined && (c.stubLockHash !== stubLockHash || c.compilerVersion !== COMPILER_ID || c.irHash !== u.hash)) forceReplan.add(`${a.path} ${u.id}`);
      // A documented event built without the tooltip (backend without event_meta) is applied again once the backend can write it.
      else if (c !== undefined && hasEventTooltip(u) && (c.eventMeta ?? false) !== (caps.eventMeta === true)) forceReplan.add(`${a.path} ${u.id}`);
    }
  }

  // Assets that cannot have anything to plan are not read (no drift check there; `abfc status` still reads everything), unless `readAll`.
  const tRead = performance.now();
  const existing = owned.filter((a) => !missing.has(a.path));
  const toRead = readAll ? new Set(existing.map((a) => a.path)) : assetsNeedingRead({ ...ir, assets: existing }, { manifests, stage, forceReplan, directorRows: caps.classManagerRows });
  const readAssets = existing.filter((a) => toRead.has(a.path));
  const skipped = existing.filter((a) => !toRead.has(a.path));
  const snapshots = new Map<string, Map<string, T3dNode>>();
  const snapshotVariables = new Map<string, string[]>();
  const snapshotVariableTypes = new Map<string, Map<string, string>>();
  for (const a of readAssets) {
    const { parsed } = await readAsset(ctx, backend, a.path);
    snapshots.set(a.path, parsed.nodes);
    snapshotVariables.set(a.path, parsed.variables.map((v) => v.name));
    snapshotVariableTypes.set(a.path, new Map(parsed.variables.map((v) => [v.name, v.type])));
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

  const planIr: IrModule = { ...ir, assets: [...structAssets, ...owned.filter((a) => toRead.has(a.path) || missing.has(a.path))] };
  const planned = planBuild(planIr, {
    manifests,
    snapshots,
    stage,
    handMadeUnits: new Map(fe.hir.classes.map((c) => [c.path, c.manualUnits])),
    hybrid: new Set(fe.hir.classes.filter((c) => c.hybrid).map((c) => c.path)),
    snapshotVariables,
    snapshotVariableTypes,
    forceReplan,
    selfEventCalls: caps.selfEventCalls,
    missing,
    createKinds: caps.createKinds,
    directorRows: caps.classManagerRows,
  });
  if (emitAll(ctx, planned.diagnostics)) return false;
  for (const a of skipped) for (const u of a.units) planned.upToDate.push(`${a.path} ${u.id}`);

  // Manifests of assets this build does not touch still learn where their class lives now (an older manifest has no source yet).
  const refreshSources = (touched: ReadonlySet<string>): void => {
    for (const [p, m] of manifests) {
      const s = sources.get(p);
      if (m === null || s === undefined || touched.has(p)) continue;
      if (m.source?.file === s.file && m.source.class === s.class && m.source.derived === s.derived) continue;
      writeManifest(projectDir, { ...m, source: s });
    }
  };

  if (planned.plan.assets.length === 0) {
    refreshSources(new Set());
    writeCache(ctx, owned, cache, stubLockHash, caps.eventMeta === true);
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

  const irByPath = new Map(owned.map((a) => [a.path, a]));
  if (!applied.ok) {
    let reported = 0;
    planned.plan.assets.forEach((a, i) => {
      const outcome = applied.perAsset[i];
      const irAsset = irByPath.get(a.asset);
      if (outcome !== undefined && irAsset === undefined && a.struct !== undefined) {
        for (const m of outcome.compile) {
          output.diag({ severity: "error", code: "ABFC4002", asset: a.asset, message: `[backend] ${m.message}` });
          reported++;
        }
        return;
      }
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
  const createdStructs: string[] = [];
  const removedUnits: string[] = [];
  let removedOrphanTags = 0;
  // Gameplay tags the defaults pass added to the stage's tag list (backend 2.6.0); they reach the mod with `abfc publish`.
  const tagsAdded = applied.tagsAdded ?? [];
  for (const t of tagsAdded) output.info(`gameplay tag ${t}: added to the mod's tag list (published with abfc publish)`);
  // The constants of .abfc/tags.d.ts follow: the stored game list, the mod's own ini, and the tags that live only in the stage until publish.
  if (tagsAdded.length > 0) refreshTagsFile(ctx, tagsAdded);
  for (let i = 0; i < planned.plan.assets.length; i++) {
    const a = planned.plan.assets[i]!;
    const outcome = applied.perAsset[i]!;
    if (a.struct !== undefined) {
      // The struct exists in the stage now (the backend compiled it): record the field hash that guards later changes.
      writeManifest(projectDir, { asset: a.asset, compiler: COMPILER_ID, profile: profile.id, units: [], variables: [], structFieldsHash: structFieldsHash(a.struct.fields), ...(sources.has(a.asset) ? { source: sources.get(a.asset)! } : {}) });
      createdStructs.push(a.asset.slice(a.asset.lastIndexOf("/") + 1));
      continue;
    }
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
    // TS wins: variables removed from the asset (and own fields gone from the TS) leave the manifest too.
    const goneVars = new Set([...(a.removeVariables ?? []), ...(a.forgetVariables ?? [])]);
    const variables = (old?.variables ?? []).filter((v) => !goneVars.has(v.name));
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
    // The class-manager row the backend wrote for `@director` (recorded with the defaults hash, only after pass 5 succeeded).
    // A class that no longer has a `@director` drops the record once the pass ran (the row asset itself stays in the mod).
    const lostDirector = defaultsDone && a.defaults!.director === undefined && old?.directorRow !== undefined;
    const directorRow = defaultsDone && outcome.directorRow !== undefined ? outcome.directorRow.asset : lostDirector ? undefined : old?.directorRow;
    if (defaultsDone && outcome.directorRow !== undefined && (outcome.directorRow.created || outcome.directorRow.changed)) {
      output.info(`class-manager row ${outcome.directorRow.asset}: ${outcome.directorRow.created ? "created" : "updated"}`);
    }
    if (defaultsDone && outcome.directorRow !== undefined && old?.directorRow !== undefined && old.directorRow.toLowerCase() !== outcome.directorRow.asset.toLowerCase()) {
      output.diag({
        severity: "warning",
        code: "ABFC5013",
        asset: a.asset,
        message: `the previous class-manager row ${old.directorRow} stays in the mod; delete it in the Mod Editor`,
      });
    }
    if (lostDirector) {
      output.diag({
        severity: "warning",
        code: "ABFC5013",
        asset: a.asset,
        message: `the class has no @director any more; its class-manager row ${old!.directorRow} stays in the mod; delete it in the Mod Editor`,
      });
    }
    const appliedIds = new Set(a.units.map((p) => p.unit.id));
    // Removed from the stage, not published yet: `abfc publish` lists the asset until a publish clears this.
    const retiredUnpublished = [...new Set([...(old?.retiredUnpublished ?? []), ...retired])].sort();
    const source = sources.get(a.asset) ?? old?.source;
    const finalManifest: Manifest = {
      asset: a.asset,
      compiler: COMPILER_ID,
      profile: profile.id,
      units,
      variables,
      ...(classDefaultsHash !== undefined ? { classDefaultsHash } : {}),
      ...(classDefaultsStageSyncedAt !== undefined ? { classDefaultsStageSyncedAt } : {}),
      ...(directorRow !== undefined ? { directorRow } : {}),
      ...(retiredUnpublished.length > 0 ? { retiredUnpublished } : {}),
      ...(source !== undefined ? { source } : {}),
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
      ...(old?.directorRow !== undefined ? { directorRow: old.directorRow } : {}),
      ...(retiredUnpublished.length > 0 ? { retiredUnpublished } : {}),
      ...(source !== undefined ? { source } : {}),
    });
    writeSourceMap(projectDir, sourceMapOf(irAsset, { ...previousNames(old), ...outcome.nodeIds }));
    appliedAssets.push(a.asset);
  }

  // Unreal's own compile of the changed assets.
  const tCompile = performance.now();
  // A struct was compiled by the backend when it was created; a build that only created structs has nothing else to compile.
  const report = appliedAssets.length > 0 ? await backend.compile(mod, appliedAssets) : ({ clean: true, messages: [] } as unknown as Awaited<ReturnType<typeof backend.compile>>);
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
    // The stage now holds graphs Unreal could not compile. Re-sync it from the mod so a later build starts from a clean copy
    // (the next build applies the units again, as it does after `--resync`).
    let stageResynced = false;
    if (!args.flags.keepFailedStage && env.modDir.value !== null) {
      const tR = performance.now();
      try {
        await backend.stage(env.modDir.value, { discardChanges: true });
        stageResynced = true;
        await pruneManifestsToStage(ctx, backend, mod, { base: manifests, appliedAssets, ir, owned });
        output.info("the stage was re-synced from the mod: all unpublished changes in the staged copy were discarded; the next build applies the units again (--keep-failed-stage keeps them for inspection)");
      } catch (e) {
        output.diag({
          severity: "warning",
          code: "ABFC4016",
          message: `the stage could not be re-synced after the failed compile: ${e instanceof Error ? e.message : String(e)}`,
          fix: "run abfc build --resync before the next build.",
        });
      }
      rec.record("build.resync", since(tR), stageResynced);
    } else if (args.flags.keepFailedStage) {
      output.info("the stage keeps the graphs that failed to compile (--keep-failed-stage); abfc build --resync discards them");
    }
    output.json({ applied: [], compileFailed: true, stageResynced });
    return false;
  }
  for (const m of finals) writeManifest(projectDir, m);
  refreshSources(new Set(planned.plan.assets.map((a) => a.asset)));
  for (const m of report.messages) if (m.severity === "warning" && args.flags.verbose) output.info(`[Unreal warning] ${m.message}`);

  writeCache(ctx, owned, cache, stubLockHash, caps.eventMeta === true);
  output.info(`applied ${stagedUnits.length > 0 ? stagedUnits.join(", ") : "no units"} in ${appliedAssets.join(", ")} (route: ${route})${createdStructs.length > 0 ? `, created struct ${createdStructs.join(", ")}` : ""}${removedUnits.length > 0 ? `, removed ${removedUnits.join(", ")}` : ""}${removedOrphanTags > 0 ? `, removed ${removedOrphanTags} orphan tag comment(s)` : ""}`);
  output.json({ applied: stagedUnits, assets: appliedAssets, ...(createdStructs.length > 0 ? { structs: createdStructs } : {}), route, upToDate: planned.upToDate, ...(removedUnits.length > 0 ? { removed: removedUnits } : {}), ...(removedOrphanTags > 0 ? { removedOrphanTags } : {}) });
  return true;
}

/** `abfc build`. */
export async function build(ctx: CliContext): Promise<number> {
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  try {
    await runBuild(ctx, session, rec, { readAll: ctx.args.flags.drift });
  } finally {
    await session.close();
    rec.print();
  }
  return ctx.output.exitCode();
}
