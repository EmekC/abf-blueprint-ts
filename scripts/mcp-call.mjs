#!/usr/bin/env node
// Dev only (not published): calls one allowed backend tool with abfc's own environment resolution and prints the JSON.
//
//   node scripts/mcp-call.mjs --project <dir> --tool <name> (--args '<json>' | --args-json <file>) [--out <file>]
//
// The environment comes from @abfc/env with the same precedence as the CLI (flag > env > abf.config.json > user config >
// auto). The tool allowlist of @abfc/backend applies, so bp_publish is refused before anything is sent. A relative
// `spec_file` argument is resolved against --project. Build first: npm run build.
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { spawnBackendServer } from "@abfc/backend";
import { findProjectDir, realHost, resolveEnvironment } from "@abfc/env";

const { values } = parseArgs({
  options: {
    project: { type: "string" },
    tool: { type: "string" },
    args: { type: "string" },
    "args-json": { type: "string" },
    out: { type: "string" },
    "editor-root": { type: "string" },
    "mods-dir": { type: "string" },
    "mod-dir": { type: "string" },
    "backend-dir": { type: "string" },
    python: { type: "string" },
    "headless-dir": { type: "string" },
  },
  strict: true,
});

function fail(message) {
  process.stderr.write(`mcp-call: ${message}\n`);
  process.exit(2);
}

if (values.tool === undefined) fail("--tool <name> is required");
if (values.project === undefined) fail("--project <dir> is required");
if (values.args !== undefined && values["args-json"] !== undefined) fail("give --args or --args-json, not both");

let toolArgs = {};
try {
  const text = values.args ?? (values["args-json"] !== undefined ? readFileSync(values["args-json"], "utf8") : "{}");
  toolArgs = JSON.parse(text.replace(/^﻿/, ""));
} catch (e) {
  fail(`the tool arguments are not valid JSON: ${e.message}`);
}
if (typeof toolArgs !== "object" || toolArgs === null || Array.isArray(toolArgs)) fail("the tool arguments must be a JSON object");

const host = realHost();
let projectDir;
let env;

const flags = {};
if (values["editor-root"] !== undefined) flags.editorRoot = values["editor-root"];
if (values["mods-dir"] !== undefined) flags.modsDir = values["mods-dir"];
if (values["mod-dir"] !== undefined) flags.modDir = values["mod-dir"];
if (values["backend-dir"] !== undefined) flags.backendDir = values["backend-dir"];
if (values.python !== undefined) flags.python = values.python;
if (values["headless-dir"] !== undefined) flags.headlessDir = values["headless-dir"];

try {
  projectDir = findProjectDir(resolve(values.project), (p) => host.exists(p));
  env = resolveEnvironment(host, { projectDir, flags });
} catch (e) {
  fail(e.diagnostic ? `${e.diagnostic.code}: ${e.diagnostic.message}` : e.message);
}
if (typeof toolArgs.spec_file === "string" && !isAbsolute(toolArgs.spec_file)) {
  toolArgs.spec_file = resolve(projectDir, toolArgs.spec_file);
}
for (const [what, r] of [["Python", env.python], ["the backend folder", env.backendDir], ["the headless folder", env.headlessDir]]) {
  if (r.value === null) fail(`${what} is not resolved; run abfc doctor first`);
}

const client = await spawnBackendServer({
  python: env.python.value,
  backendDir: env.backendDir.value,
  headlessDir: env.headlessDir.value,
  editorRoot: env.editorRoot.value,
});
let code = 0;
try {
  const res = await client.callTool(values.tool, toolArgs);
  const doc = JSON.stringify({ tool: values.tool, isError: res.isError, wallSeconds: res.wallSeconds, result: res.json ?? res.text }, null, 2);
  if (values.out !== undefined) writeFileSync(values.out, doc + "\n", "utf8");
  else process.stdout.write(doc + "\n");
  if (res.isError) code = 1;
} catch (e) {
  process.stderr.write(`mcp-call: ${e.diagnostic ? `${e.diagnostic.code}: ${e.diagnostic.message}` : e.message}\n`);
  code = e.exitCode ?? 1;
} finally {
  await client.close();
}
process.exit(code);
