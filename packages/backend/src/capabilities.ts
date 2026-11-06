import type { BackendCapabilities } from "@abfc/ir";

/** The JSON of `backend_info` (wildcard-pins branch of abf-mod-editor-mcp); every key optional, unknown keys ignored. */
export interface RawBackendInfo {
  protocol?: unknown;
  serverVersion?: unknown;
  editorRoot?: unknown;
  headlessDir?: unknown;
  documentsDir?: unknown;
  capabilities?: {
    pinTypes?: unknown;
    containerTypes?: { array?: unknown; map?: unknown; set?: unknown } | null;
    warmSession?: unknown;
    stageAudit?: unknown;
  } | null;
  bpApply?: { features?: unknown; nodeKinds?: unknown } | null;
}

/** abfc's static view of bp_apply protocol 1; `capabilitiesFrom` overlays what the backend reports. */
export const BP_APPLY_P1_BASE: BackendCapabilities = {
  protocol: 0,
  writers: ["memswap"],
  headless: true,
  needsOpenEditor: false,
  createKinds: ["Blueprint", "WidgetBlueprint", "BlueprintInterface"],
  containerTypes: { array: true, set: false, map: false },
  userPureFunctions: false,
  functionLocals: false,
  rawNodes: true,
  replicatedEvents: false,
  classDefaults: true,
  multiPassPerAsset: false,
  transactional: false,
  compileErrorNodeRefs: false,
  nodeNameMap: true,
  reflect: false,
  gameTest: false,
  audit: false,
  publish: false,
  warmSession: false,
  stageAudit: false,
  pinTypes: false,
  castObjectPin: false,
  selfEventCalls: false,
  bpApplyFeatures: [],
  nodeKinds: [],
  backendContainerTypes: null,
};

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function bool(v: unknown): boolean {
  return v === true;
}

/**
 * Phase 1 gate: `pinTypes` needs `backend_info` to say so AND list `pin_types`; the container policy stays abfc's own
 * (array only), the backend's report is kept in `backendContainerTypes` for `abfc doctor`.
 */
export function capabilitiesFrom(
  tools: string[],
  info: RawBackendInfo | null,
  ext: { features?: string[] } | null,
): BackendCapabilities {
  const bpApplyFeatures = strings(info?.bpApply?.features);
  const rawContainers = info?.capabilities?.containerTypes ?? null;
  return {
    ...BP_APPLY_P1_BASE,
    containerTypes: { ...BP_APPLY_P1_BASE.containerTypes },
    protocol: typeof info?.protocol === "number" ? info.protocol : 0,
    bpApplyFeatures,
    pinTypes: bool(info?.capabilities?.pinTypes) && bpApplyFeatures.includes("pin_types"),
    castObjectPin: bpApplyFeatures.includes("cast_object_pin"),
    selfEventCalls: bpApplyFeatures.includes("self_event_calls"),
    nodeKinds: strings(info?.bpApply?.nodeKinds),
    backendContainerTypes:
      rawContainers === null
        ? null
        : { array: bool(rawContainers.array), set: bool(rawContainers.set), map: bool(rawContainers.map) },
    reflect: tools.includes("reflect"),
    gameTest: tools.includes("bp_game_test"),
    audit: tools.includes("mod_audit"),
    publish: tools.includes("bp_publish"),
    compileErrorNodeRefs: ext?.features?.includes("compile_node_refs") ?? false,
    warmSession: bool(info?.capabilities?.warmSession) && tools.includes("warm_session"),
    stageAudit: bool(info?.capabilities?.stageAudit),
  };
}
