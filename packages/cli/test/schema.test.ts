// The abf.config.json JSON schema (packages/cli/schema) stays in step with what `abfc init` writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { projectConfigText } from "../src/init/templates.js";

// compiled to packages/cli/dist/test/
const here = dirname(fileURLToPath(import.meta.url));
const schemaFile = join(here, "..", "..", "schema", "abf.config.schema.json");

interface Schema {
  $schema: string;
  title: string;
  required: string[];
  properties: Record<string, { properties?: Record<string, { pattern?: string }> }>;
}

function loadSchema(): Schema {
  return JSON.parse(readFileSync(schemaFile, "utf8")) as Schema;
}

test("the schema parses and names the required key", () => {
  const schema = loadSchema();
  assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema.title, "abfc project configuration (abf.config.json)");
  assert.deepEqual(schema.required, ["mod"]);
});

test("every top-level key written by abfc init is described", () => {
  const schema = loadSchema();
  const written = JSON.parse(projectConfigText("ExampleMod", [])) as Record<string, unknown>;
  for (const key of Object.keys(written)) assert.ok(key in schema.properties, `${key} in properties`);
});

test("the mod.name pattern accepts ExampleMod and rejects a name with a space", () => {
  const pattern = loadSchema().properties.mod?.properties?.name?.pattern;
  assert.ok(pattern !== undefined, "mod.name has a pattern");
  const re = new RegExp(pattern);
  assert.ok(re.test("ExampleMod"));
  assert.ok(re.test("Example_Mod2"));
  assert.ok(!re.test("Example Mod"));
  assert.ok(!re.test(""));
});
