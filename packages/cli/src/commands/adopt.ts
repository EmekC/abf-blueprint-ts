import { AdoptionError, adoptionDiagnostics, analyzeAdoption, readManifest, writeManifest } from "@abfc/compiler";
import type { AdoptionAnalysis, Manifest, ManifestUnit } from "@abfc/compiler";
import { unitStateHash } from "@abfc/ir";
import { UsageError } from "../args.js";
import type { CliContext } from "../context.js";
import { BackendSession, COMPILER_ID, Recorder, pruneManifestsToStage, readAsset } from "./common.js";
import { ensureStage } from "./stage.js";

/**
 * Deprecated (warning ABFC5015): a build replaces hand-made units of the same name on its own.
 * `abfc adopt <asset> <unit> [--remove-node <name>]... [--yes] [--discard-editor-changes]`: records a hand-made event or engine
 * override (`override:ReceiveTick`) as owned; `--remove-node` adds comment boxes and unlinked nodes that go away with it. Never calls `bp_apply`.
 * A unit abfc has already applied is refused unless `--discard-editor-changes` is given; the next build then removes its
 * old nodes and ownership comment as well as the adopted ones.
 */
export async function adopt(ctx: CliContext): Promise<number> {
  const { output, args, config, env, projectDir } = ctx;
  const [asset, unitArg] = args.positionals;
  if (asset === undefined || unitArg === undefined || args.positionals.length > 2) {
    throw new UsageError("usage: abfc adopt <asset> <unit> [--remove-node <name>]... [--yes] [--discard-editor-changes]  (unit: UpdateTarget, event:UpdateTarget or override:ReceiveTick)");
  }
  const colon = unitArg.indexOf(":");
  const kind = colon < 0 ? "event" : unitArg.slice(0, colon);
  if (kind !== "event" && kind !== "override") {
    throw new UsageError(`only events and overrides can be adopted, got "${unitArg}"`);
  }
  const unitName = colon < 0 ? unitArg : unitArg.slice(colon + 1);
  const unitId = `${kind}:${unitName}`;
  const graph = "EventGraph";
  output.diag({
    severity: "warning",
    code: "ABFC5015",
    asset,
    message: `abfc adopt is not needed any more: abfc build replaces a hand-made ${kind === "override" ? "override" : "event"} of the same name as a TypeScript unit (TypeScript wins). The command still works and is kept for compatibility.`,
    fix: `declare ${unitName} in TypeScript and run abfc build; use abfc adopt only if you want the hand-made nodes to stay as they are until the first build.`,
  });

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
    const { status: stage, resynced } = await ensureStage(backend, env, config, { resync: args.flags.resync, warn: (d) => output.diag(d) });
    if (resynced) await pruneManifestsToStage(ctx, backend, config.mod.name);
    const { parsed } = await readAsset(ctx, backend, asset);

    let analysis: AdoptionAnalysis;
    try {
      analysis = analyzeAdoption(parsed.nodes, graph, unitName, { kind, extraNodes: args.flags.removeNode });
    } catch (e) {
      if (e instanceof AdoptionError) {
        output.diag({ severity: "error", code: e.code, message: e.message.slice(e.code.length + 2), asset });
        return output.exitCode();
      }
      throw e;
    }
    const otherUnitNodes = new Set<string>();
    for (const u of existing?.units ?? []) {
      if (u.id === unitId) continue;
      for (const n of [...u.nodes, ...(u.adopt?.nodes ?? [])]) otherUnitNodes.add(n);
    }
    const problems = adoptionDiagnostics(analysis, asset, unitName, otherUnitNodes);
    if (problems.length > 0) {
      for (const d of problems) output.diag(d);
      return output.exitCode();
    }

    output.info(`adopt ${unitId} in ${asset}`);
    output.info(`  entry: ${analysis.entry}`);
    output.info(`  owned nodes (${analysis.owned.length}): ${analysis.owned.join(", ")}`);
    if (analysis.extra.length > 0) output.info(`  removed with it (--remove-node): ${analysis.extra.join(", ")}`);
    for (const c of analysis.crossLinks) {
      output.info(`  delegate link: ${c.node}.${c.pin} ${c.role === "uses" ? "uses the entry" : "takes this unit as its delegate from"} ${c.entry}`);
    }
    output.json({ asset, unit: unitId, entry: analysis.entry, owned: analysis.owned, extra: analysis.extra, crossLinks: analysis.crossLinks, written: args.flags.yes });

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
        ...(analysis.crossLinks.length > 0 ? { crossLinks: analysis.crossLinks } : {}),
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
