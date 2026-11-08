import { compareServerVersion, MIN_BACKEND_VERSION, RECOMMENDED_BACKEND_VERSION } from "@abfc/backend";
import { envWarning } from "@abfc/env";
import type { BackendInfo, Diagnostic } from "@abfc/ir";

/**
 * Problems of the backend's `backend_info`, in order: warning ABFC4012 (no `backend_info` tool), error ABFC4001 (protocol below
 * `minProtocol`), warning ABFC4014 (server older than {@link MIN_BACKEND_VERSION}; unparseable versions never warn).
 */
export function backendInfoDiagnostics(info: BackendInfo, minProtocol: number, backendDir: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (info.protocol === null) {
    out.push(
      envWarning(
        4012,
        `the backend at ${backendDir} (server ${info.serverVersion}) has no backend_info tool (older abf-mod-editor-mcp).`,
        [],
        `update the backend to a version with backend_info; until then wildcard pins use the two-phase fallback. abfc needs abf-mod-editor-mcp >= ${MIN_BACKEND_VERSION}`,
      ),
    );
  } else if (info.protocol < minProtocol) {
    out.push({
      severity: "error",
      code: "ABFC4001",
      message:
        `abf-mod-editor-mcp at ${backendDir} (server ${info.serverVersion}) reports protocol ${info.protocol}; ` +
        `abfc needs protocol >= ${minProtocol}. Update it (see docs/backend.md).`,
      fix: "update the abf-mod-editor-mcp checkout.",
    });
  }
  if (info.protocol !== null && compareServerVersion(info.serverVersion, MIN_BACKEND_VERSION) === -1) {
    out.push(
      envWarning(
        4014,
        `abf-mod-editor-mcp at ${backendDir} is server ${info.serverVersion}; abfc needs ${MIN_BACKEND_VERSION} or newer. Older servers miss capabilities abfc uses (see docs/backend.md).`,
        [],
        `update the checkout to tag v${MIN_BACKEND_VERSION} or newer of EmekC/abf-mod-editor-mcp.`,
      ),
    );
  }
  return out;
}

/** The 2.6.0 capabilities abfc can use, by the name `abfc doctor` prints, that this backend lacks. */
export function missingRecommendedCapabilities(info: BackendInfo): string[] {
  const c = info.capabilities;
  const missing: string[] = [];
  if (c.assetOps.length === 0) missing.push("assetOps");
  if (!c.publishDeletes) missing.push("publishDeletes");
  if (!c.gameplayTags) missing.push("gameplayTags");
  if (!c.reflectDefaults) missing.push("reflectDefaults");
  return missing;
}

/**
 * `abfc doctor` only: warning ABFC4018 when the server is older than {@link RECOMMENDED_BACKEND_VERSION} or lacks one of the
 * capabilities `assetOps`, `publishDeletes`, `gameplayTags`, `reflectDefaults`. Nothing for a backend without `backend_info`
 * (ABFC4012 covers it).
 */
export function recommendedBackendDiagnostics(info: BackendInfo, backendDir: string): Diagnostic[] {
  if (info.protocol === null) return [];
  const missing = missingRecommendedCapabilities(info);
  const older = compareServerVersion(info.serverVersion, RECOMMENDED_BACKEND_VERSION) === -1;
  if (missing.length === 0 && !older) return [];
  const what = missing.length > 0 ? ` and lacks the capabilities ${missing.join(", ")}` : "";
  return [
    envWarning(
      4018,
      `abf-mod-editor-mcp at ${backendDir} is server ${info.serverVersion}${what}; abfc recommends ${RECOMMENDED_BACKEND_VERSION} or newer. Renames, moves and deletions of assets, deletions on publish, gameplay tags and parameter defaults then fall back to warnings or are skipped (see docs/backend.md).`,
      [],
      `update abf-mod-editor-mcp to ${RECOMMENDED_BACKEND_VERSION} (tag v${RECOMMENDED_BACKEND_VERSION}) or newer, or use abfc.exe, which bundles a current backend.`,
    ),
  ];
}
