import { driftDiagnostics, ownedSets, readManifest, readSourceMap, unitState } from "@abfc/compiler";
import type { Span } from "@abfc/ir";
import type { CliContext } from "../context.js";
import { BackendSession, Recorder, readAsset, shortHash } from "./common.js";
import { ensureStage } from "./stage.js";

/** `abfc status`: state of every owned unit and of the staged copy. */
export async function status(ctx: CliContext): Promise<number> {
  const { output, config, env, args, projectDir } = ctx;
  const rec = new Recorder(ctx);
  const session = new BackendSession(ctx, rec);
  try {
    const { backend } = await session.open("status.backendStart");
    const stage = await ensureStage(backend, env, config, { resync: args.flags.resync });
    const rows: Array<{ asset: string; unit: string; state: string; irHash: string | null; assetHash: string | null }> = [];

    for (const asset of Object.keys(ownedSets(projectDir))) {
      const manifest = readManifest(projectDir, asset);
      if (manifest === null) continue;
      const { parsed } = await readAsset(ctx, backend, asset);
      const sm = readSourceMap(projectDir, asset);
      const spans = new Map<string, Span>();
      for (const [id, u] of Object.entries(sm?.units ?? {})) spans.set(id, u.span);
      for (const u of manifest.units) {
        const state = unitState(u, parsed.nodes, stage);
        rows.push({ asset, unit: u.id, state, irHash: u.irHash === "" ? null : u.irHash, assetHash: u.assetHash });
        output.info(`${asset} ${u.id} ${state} ${shortHash(u.irHash)} ${shortHash(u.assetHash)}`);
      }
      for (const d of driftDiagnostics(asset, manifest.units, parsed.nodes, stage, spans)) output.diag(d);
    }
    if (rows.length === 0) output.info("no owned units yet (run abfc build, or abfc adopt)");
    output.info(
      `staging: changed ${stage.changed.length}, added ${stage.added.length}, removed ${stage.removed.length}, conflicts ${stage.conflicts.length}`,
    );
    output.json({
      units: rows,
      staging: { changed: stage.changed, added: stage.added, removed: stage.removed, conflicts: stage.conflicts },
    });
    return output.exitCode();
  } finally {
    await session.close();
  }
}
