import type { Backend, StageStatus } from "@abfc/backend";
import { AbfcError } from "@abfc/env";
import type { Environment, ProjectConfig } from "@abfc/env";

/**
 * Makes sure the mod has a staged copy and returns its status. `resync` discards the stage and copies the real mod again;
 * otherwise an existing stage is kept (its edits are the work in progress). A stage that conflicts with the real mod is
 * ABFC4020 (exit 2). `resynced` is true when the stage was copied from the mod in this call (`resync`, or no stage existed): the
 * caller prunes the manifests to what the stage holds ({@link pruneManifestsToStage}), because unpublished work is gone.
 */
export async function ensureStage(
  backend: Backend,
  env: Environment,
  config: ProjectConfig,
  o: { resync: boolean },
): Promise<{ status: StageStatus; resynced: boolean }> {
  const mod = config.mod.name;
  const modDir = env.modDir.value;
  const stageFrom = async (discardChanges: boolean): Promise<StageStatus> => {
    if (modDir === null) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC1004",
        message: `mod folder of ${mod} not found; the stage cannot be created.`,
        fix: "run abfc doctor, or pass --mod-dir.",
      });
    }
    await backend.stage(modDir, { discardChanges });
    const status = await backend.stageStatus(mod);
    if (status === null) {
      throw new AbfcError({
        severity: "error",
        code: "ABFC4002",
        message: `staging_sync for ${mod} finished but staging_status reports no stage.`,
      });
    }
    return status;
  };

  let status: StageStatus | null;
  let resynced = false;
  if (o.resync) {
    status = await stageFrom(true);
    resynced = true;
  } else {
    status = await backend.stageStatus(mod);
    if (status === null) {
      status = await stageFrom(false);
      resynced = true;
    }
  }
  if (status.conflicts.length > 0) {
    throw new AbfcError({
      severity: "error",
      code: "ABFC4020",
      message: `the staged copy of ${mod} conflicts with the real mod: ${status.conflicts.join(", ")}.`,
      fix: "run: abfc build --resync",
    });
  }
  return { status, resynced };
}
