import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/index.js";

test("the recommended config enables every rule as a warning", () => {
  const names = Object.keys(plugin.rules).map((n) => `abfc/${n}`).sort();
  assert.deepEqual(Object.keys(plugin.configs.recommended.rules).sort(), names);
  assert.ok(names.every((n) => plugin.configs.recommended.rules[n] === "warn"));
  assert.equal(plugin.configs.recommended.plugins.abfc, plugin);
  assert.equal(plugin.meta.name, "@abfc/eslint-plugin");
});
