import { AdoptionError, adoptionDiagnostics, analyzeAdoption, readManifest, writeManifest } from "@abfc/compiler";
import type { AdoptionAnalysis, Manifest, ManifestUnit } from "@abfc/compiler";
import { unitStateHash } from "@abfc/ir";
import { UsageError } from "../args.js";
import type { CliContext } from "../context.js";
import { BackendSession, COMPILER_ID, Recorder, readAsset } from "./common.js";
import { ensureStage } from "./stage.js";

/**
 * `abfc adopt <asset> <unit> [--yes] [--discard-editor-changes]`: records a hand-made event as owned. Never calls `bp_apply`.
 * A unit abfc has already applied is refused unless `--discard-editor-changes` is given; the next build then removes its
 * old nodes and ownership comment as well as the adopted ones.
 */
export async function adopt(ctx: CliContext): Promise<number> {
  const { output, args, config, env, projectDir } = ctx;
  const [asset, unitArg] = args.positionals;
  if (asset === undefined || unitArg === undefined || args.positionals.length > 2) {
    throw new UsageError("usage: abfc adopt <asset> <unit> [--yes] [--discard-editor-changes]  (unit: UpdateTarget or event:UpdateTarget)");
  }
  const colon = unitArg.indexOf(":");
  if (colon >= 0 && unitArg.slice(0, colon) !== "event") {
    throw new UsageError(`only events can be adopted in Phase 1, got "${unitArg}"`);
  }
  const unitName = colon < 0 ? unitArg : unitArg.slice(colon + 1);
  const unitId = `event:${unitName}`;
  const graph = "EventGraph";

  const existing = readManifest(projectDir, asset);
  const old = existing?.units.find((u) => u.id === unitId);
  const applied = old !== undefined && (old.stageSyncedAt !== null || old.nodes.length > 0);
  const discard = args.flags.discardEditorChanges;
  if (applied && !discard) {
    output.diag({
      severity: "error",
      code: "ABFC5007",
      message: `${unitName} in ${asset} was already applied by abfc; adopting it again would replace the generated nodes and discard any edit made to them in the editor. Nothing was written.`,
      fix: `to replace it with the hand-made version anyway, run: abfc adopt ${asset} ${unitName} --yes --discard-editor-changes`,
    });
    return output.exitCode();
  }

  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  try {
    const { backend } = await session.open("adopt.backendStart");
    const stage = await ensureStage(backend, env, config, { resync: args.flags.resync });
    const { parsed } = await readAsset(ctx, backend, asset);

    let analysis: AdoptionAnalysis;
    try {
      analysis = analyzeAdoption(parsed.nodes, graph, unitName);
    } catch (e) {
      if (e instanceof AdoptionError) {
        output.diag({ severity: "error", code: e.code, message: e.message.slice(e.code.length + 2), asset });
        return output.exitCode();
      }
      throw e;
    }
    const problems = adoptionDiagnostics(analysis, asset, unitName);
    if (problems.length > 0) {
      for (const d of problems) output.diag(d);
      return output.exitCode();
    }

    output.info(`adopt ${unitId} in ${asset}`);
    output.info(`  entry: ${analysis.entry}`);
    output.info(`  owned nodes (${analysis.owned.length}): ${analysis.owned.join(", ")}`);
    output.json({ asset, unit: unitId, entry: analysis.entry, owned: analysis.owned, written: args.flags.yes });

    if (!args.flags.yes) {
      output.diag({
        severity: "error",
        code: "ABFC5006",
        message: `adopting ${unitName} records ${analysis.owned.length} node(s) of ${asset} as owned by abfc; nothing was written.`,
        fix: `run: abfc adopt ${asset} ${unitName} --yes`,
      });
      return output.exitCode();
    }

    // with --discard-editor-changes the old generated nodes and their ownership comment are removed by the next build too
    const owned = [...analysis.owned];
    if (applied && old !== undefined) {
      for (const name of [...old.nodes, ...(old.tag !== null ? [old.tag] : [])]) {
        if (parsed.nodes.has(name) && !owned.includes(name)) owned.push(name);
      }
    }
    const fresh: ManifestUnit = {
      id: unitId,
      graph,
      irHash: "",
      assetHash: null,
      nodes: [],
      nodeIds: {},
      tag: null,
      stageSyncedAt: null,
      adopt: {
        entry: analysis.entry,
        nodes: owned,
        hash: unitStateHash(parsed.nodes, owned),
        recordedAt: ctx.deps.now().toISOString(),
        stageSyncedAt: stage.syncedAt,
      },
    };
    const manifest: Manifest = existing ?? { asset, compiler: COMPILER_ID, profile: env.profile.id, units: [], variables: [] };
    const at = manifest.units.findIndex((u) => u.id === unitId);
    if (at >= 0) manifest.units[at] = fresh;
    else manifest.units.push(fresh);
    const file = writeManifest(projectDir, manifest);
    output.info(`recorded in ${file}`);
    return output.exitCode();
  } finally {
    await session.close();
  }
}
