import { test } from "node:test";
import assert from "node:assert/strict";
import { BP_APPLY_P1_BASE, capabilitiesFrom } from "../src/index.js";
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

test("fix-shaped backend_info and extensions: native pin types, abfc container policy stays", () => {
  const c = capabilitiesFrom(ALL_TOOLS, FIX_INFO, EXT);
  assert.equal(c.protocol, 1);
  assert.equal(c.pinTypes, true);
  assert.equal(c.castObjectPin, true);
  assert.deepEqual(c.containerTypes, { array: true, set: false, map: false });
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
