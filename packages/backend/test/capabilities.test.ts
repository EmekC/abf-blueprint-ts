import { test } from "node:test";
import assert from "node:assert/strict";
import { BP_APPLY_P1_BASE, NATIVE_POLICY, capabilitiesFrom } from "../src/index.js";
import type { RawBackendInfo } from "../src/index.js";

const ALL_TOOLS = [
  "backend_info",
  "abfc_extensions",
  "reflect",
  "staging_sync",
  "staging_status",
  "bp_apply",
  "bp_read",
  "bp_compile_report",
  "bp_game_test",
  "mod_audit",
];

const FIX_INFO: RawBackendInfo = {
  protocol: 1,
  serverVersion: "x",
  capabilities: { pinTypes: true, containerTypes: { array: true, map: true, set: false } },
  bpApply: { features: ["cast_object_pin", "map_types", "pin_types"], nodeKinds: ["call", "cast"] },
};

const EXT = { features: ["reflect", "compile_node_refs", "bp_read_seconds"] };

test("fix-shaped backend_info and extensions: native pin types, native map on, set off (backend lacks it)", () => {
  const c = capabilitiesFrom(ALL_TOOLS, FIX_INFO, EXT);
  assert.equal(c.protocol, 1);
  assert.equal(c.pinTypes, true);
  assert.equal(c.castObjectPin, true);
  assert.deepEqual(c.containerTypes, { array: true, set: false, map: true });
  assert.deepEqual(c.backendContainerTypes, { array: true, set: false, map: true });
  assert.equal(c.reflect, true);
  assert.equal(c.compileErrorNodeRefs, true);
  assert.equal(c.gameTest, true);
  assert.equal(c.audit, true);
  assert.equal(c.publish, false);
  assert.deepEqual(c.bpApplyFeatures, ["cast_object_pin", "map_types", "pin_types"]);
  assert.deepEqual(c.nodeKinds, ["call", "cast"]);
  // the shared base is not mutated
  assert.deepEqual(BP_APPLY_P1_BASE.containerTypes, { array: true, set: false, map: false });
  assert.equal(BP_APPLY_P1_BASE.pinTypes, false);
});

test("native policy is ANDed with the backend report, pin types and the struct_fields feature", () => {
  const info: RawBackendInfo = {
    protocol: 1,
    capabilities: { pinTypes: true, containerTypes: { array: true, map: true, set: true } },
    bpApply: { features: ["pin_types", "map_types", "set_types", "struct_fields"], nodeKinds: [] },
  };
  const all = { map: true, set: true, struct: true };
  const c = capabilitiesFrom(ALL_TOOLS, info, null, all);
  assert.deepEqual(c.containerTypes, { array: true, set: true, map: true });
  assert.deepEqual(c.createKinds, ["Blueprint", "WidgetBlueprint", "BlueprintInterface", "UserDefinedStruct"]);
  // policy off: the backend alone is not enough
  const none = capabilitiesFrom(ALL_TOOLS, info, null, { map: false, set: false, struct: false });
  assert.deepEqual(none.containerTypes, { array: true, set: false, map: false });
  assert.equal(none.createKinds.includes("UserDefinedStruct"), false);
  // backend off: the policy alone is not enough
  const noBackend: RawBackendInfo = {
    protocol: 1,
    capabilities: { pinTypes: true, containerTypes: { array: true, map: false, set: false } },
    bpApply: { features: ["pin_types"], nodeKinds: [] },
  };
  const b = capabilitiesFrom(ALL_TOOLS, noBackend, null, all);
  assert.deepEqual(b.containerTypes, { array: true, set: false, map: false });
  assert.equal(b.createKinds.includes("UserDefinedStruct"), false);
  // no native pin types: containers stay off even when the backend reports them
  const noPins: RawBackendInfo = { ...info, capabilities: { pinTypes: false, containerTypes: { array: true, map: true, set: true } } };
  assert.deepEqual(capabilitiesFrom(ALL_TOOLS, noPins, null, all).containerTypes, { array: true, set: false, map: false });
  // the shared base and the default policy are untouched
  assert.deepEqual(BP_APPLY_P1_BASE.createKinds, ["Blueprint", "WidgetBlueprint", "BlueprintInterface"]);
  assert.deepEqual(NATIVE_POLICY, { map: true, set: true, struct: true });
});

test("no backend_info: fallback capabilities", () => {
  const c = capabilitiesFrom(["staging_sync", "bp_apply"], null, null);
  assert.equal(c.protocol, 0);
  assert.equal(c.pinTypes, false);
  assert.equal(c.castObjectPin, false);
  assert.equal(c.backendContainerTypes, null);
  assert.equal(c.reflect, false);
  assert.equal(c.compileErrorNodeRefs, false);
});

test("capabilities.pinTypes false or non-boolean: pinTypes false", () => {
  const off: RawBackendInfo = { ...FIX_INFO, capabilities: { pinTypes: false, containerTypes: null } };
  assert.equal(capabilitiesFrom(ALL_TOOLS, off, null).pinTypes, false);
  const weird: RawBackendInfo = { ...FIX_INFO, capabilities: { pinTypes: "true" } };
  assert.equal(capabilitiesFrom(ALL_TOOLS, weird, null).pinTypes, false);
  assert.equal(capabilitiesFrom(ALL_TOOLS, off, null).backendContainerTypes, null);
});

test("features without pin_types: pinTypes false, cast_object_pin independent", () => {
  const info: RawBackendInfo = { ...FIX_INFO, bpApply: { features: ["cast_object_pin"], nodeKinds: [] } };
  const c = capabilitiesFrom(ALL_TOOLS, info, null);
  assert.equal(c.pinTypes, false);
  assert.equal(c.castObjectPin, true);
});

test("unknown keys are ignored and garbage lists become empty", () => {
  const info = { protocol: "one", bpApply: { features: "pin_types", nodeKinds: [1, "a"] }, extra: 1 } as unknown as RawBackendInfo;
  const c = capabilitiesFrom([], info, null);
  assert.equal(c.protocol, 0);
  assert.deepEqual(c.bpApplyFeatures, []);
  assert.deepEqual(c.nodeKinds, ["a"]);
});

test("warmSession needs capabilities.warmSession and the warm_session tool; stageAudit follows backend_info", () => {
  const info = { protocol: 1, capabilities: { warmSession: true, stageAudit: true } } as RawBackendInfo;
  const on = capabilitiesFrom(["warm_session"], info, null);
  assert.equal(on.warmSession, true);
  assert.equal(on.stageAudit, true);
  assert.equal(capabilitiesFrom([], info, null).warmSession, false, "the tool is missing");
  const off = capabilitiesFrom(["warm_session"], { protocol: 1, capabilities: { warmSession: false } } as RawBackendInfo, null);
  assert.equal(off.warmSession, false);
  assert.equal(off.stageAudit, false);
  assert.equal(capabilitiesFrom(["warm_session"], null, null).warmSession, false);
});

test("eventMeta follows the bp_apply feature event_meta", () => {
  const withFeature = { ...FIX_INFO, bpApply: { ...FIX_INFO.bpApply, features: [...((FIX_INFO.bpApply as { features?: string[] }).features ?? []), "event_meta"] } };
  assert.equal(capabilitiesFrom(ALL_TOOLS, withFeature, EXT).eventMeta, true);
  assert.equal(capabilitiesFrom(ALL_TOOLS, FIX_INFO, EXT).eventMeta, false);
  assert.equal(capabilitiesFrom(ALL_TOOLS, null, EXT).eventMeta, false);
});
