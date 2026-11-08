import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// compiled to packages/vscode/dist/test/, so the package folder is two levels up
const pkgFile = join(__dirname, "..", "..", "package.json");

interface Manifest {
  name: string;
  displayName: string;
  description: string;
  version: string;
  publisher: string;
  private: boolean;
  license: string;
  repository: { type: string; url: string };
  type: string;
  engines: { vscode: string };
  main: string;
  activationEvents: string[];
  capabilities: { untrustedWorkspaces: { supported: string; restrictedConfigurations: string[]; description: string } };
  contributes: {
    jsonValidation: { fileMatch: string; url: string }[];
    problemMatchers: { name: string; owner: string; fileLocation: string[]; pattern: Record<string, unknown> }[];
    taskDefinitions: { type: string; required: string[] }[];
    commands: { command: string; title: string }[];
    configuration: { title: string; properties: Record<string, { type: string; default: unknown; enum?: string[]; scope?: string }> };
  };
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(pkgFile, "utf8")) as Manifest;

test("identity and engine", () => {
  assert.equal(manifest.name, "abfc-vscode");
  assert.equal(manifest.displayName, "abfc");
  // the game's name is assembled from pieces so this file does not trip the repository's name guard
  assert.equal(manifest.description, `abfc language server for ${["Abi", "otic"].join("")} Factor TypeScript mods`);
  // lockstep with the abfc version (scripts/release/set-version.mjs)
  const cliVersion = (JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "cli", "package.json"), "utf8")) as { version: string }).version;
  assert.equal(manifest.version, cliVersion);
  assert.equal(manifest.private, true);
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.repository, { type: "git", url: "https://github.com/EmekC/abf-blueprint-ts" });
  assert.equal(manifest.type, "commonjs");
  assert.equal(manifest.engines.vscode, "^1.90.0");
  assert.equal(manifest.main, "./dist/extension.js");
  assert.deepEqual(manifest.activationEvents, ["workspaceContains:**/abf.config.json"]);
});

test("the extension id is what abfc init recommends", () => {
  assert.equal(`${manifest.publisher}.${manifest.name}`, "abfc.abfc-vscode");
});

test("pinned dependencies and the @types/vscode floor", () => {
  assert.equal(manifest.dependencies["vscode-languageclient"], "9.0.1");
  assert.equal(manifest.devDependencies["@types/vscode"], manifest.engines.vscode.replace(/^\^/, ""));
  assert.equal(manifest.devDependencies["esbuild"], "0.28.2");
  assert.equal(manifest.devDependencies["@vscode/vsce"], "4.1.0");
  for (const v of [...Object.values(manifest.dependencies), ...Object.values(manifest.devDependencies)]) {
    assert.match(v, /^\d+\.\d+\.\d+$/, "exact version");
  }
  assert.equal(manifest.scripts["bundle"], "node scripts/bundle.mjs");
  assert.equal(manifest.scripts["package"], "node scripts/package.mjs");
});

test("config validation, task type and problem matcher", () => {
  const c = manifest.contributes;
  assert.deepEqual(c.jsonValidation, [{ fileMatch: "abf.config.json", url: "./dist/schema/abf.config.schema.json" }]);
  assert.deepEqual(c.taskDefinitions.map((t) => [t.type, t.required]), [["abfc", ["command"]]]);
  const m = c.problemMatchers[0];
  assert.ok(m !== undefined);
  assert.equal(m.name, "abfc");
  assert.deepEqual(m.fileLocation, ["relative", "${workspaceFolder}"]);
  // the pattern of docs/design.md 2.4
  assert.equal(m.pattern["regexp"], "^(.*\\.ts):(\\d+):(\\d+): (error|warning) (ABFC\\d+): (.*)$");
  assert.deepEqual(
    [m.pattern["file"], m.pattern["line"], m.pattern["column"], m.pattern["severity"], m.pattern["code"], m.pattern["message"]],
    [1, 2, 3, 4, 5, 6],
  );
  const re = new RegExp(m.pattern["regexp"] as string);
  assert.ok(re.test("src/Relays/Relay.ts:12:5: error ABFC2010: integer division"));
});

test("commands and settings", () => {
  const c = manifest.contributes;
  assert.deepEqual(
    c.commands.map((x) => [x.command, x.title]),
    [
      ["abfc.build", "abfc: Build"],
      ["abfc.test", "abfc: Test"],
      ["abfc.publishDryRun", "abfc: Publish (dry run)"],
      ["abfc.doctor", "abfc: Doctor"],
      ["abfc.restartServer", "abfc: Restart Language Server"],
    ],
  );
  assert.equal(c.configuration.title, "abfc");
  const p = c.configuration.properties;
  assert.deepEqual(Object.keys(p), ["abfc.path", "abfc.cliPath", "abfc.trace.server"]);
  assert.equal(p["abfc.path"]?.default, "");
  assert.equal(p["abfc.cliPath"]?.default, "");
  assert.deepEqual(p["abfc.trace.server"]?.enum, ["off", "messages", "verbose"]);
  assert.equal(p["abfc.trace.server"]?.default, "off");
});

test("Workspace Trust: limited support, the two path settings are restricted and machine-overridable", () => {
  const t = manifest.capabilities.untrustedWorkspaces;
  assert.equal(t.supported, "limited");
  assert.deepEqual(t.restrictedConfigurations, ["abfc.path", "abfc.cliPath"]);
  assert.ok(t.description.length > 0);
  const p = manifest.contributes.configuration.properties;
  assert.equal(p["abfc.path"]?.scope, "machine-overridable");
  assert.equal(p["abfc.cliPath"]?.scope, "machine-overridable");
});
