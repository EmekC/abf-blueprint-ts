#!/usr/bin/env node
// Starts the bundled backend the way abfc does (`python -I -X utf8 backend/server.py` over stdio) and checks that it answers
// the MCP `initialize` and `tools/list` requests. Catches a runtime whose backend folder lacks a module the server imports
// (the 1.0.0 build: "No module named 'fscopy'", the process exited before answering initialize).
//
//   node scripts/release/smoke-backend.mjs [--runtime-zip <file>] [--runtime-dir <dir>] [--python <exe>] [--timeout-ms <n>]
//
// Default input: build/release/runtime/runtime.zip, extracted into a temp folder (deleted afterwards). --runtime-dir uses an
// already extracted runtime (python/python.exe and backend/server.py inside); --python overrides the interpreter.
// Exit 0 when the backend answered, 1 when it did not, 2 on a usage error.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readZip } from "@abfc/env";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = "usage: node scripts/release/smoke-backend.mjs [--runtime-zip <file>] [--runtime-dir <dir>] [--python <exe>] [--timeout-ms <n>]";

function fail(message, code = 1) {
  console.error(`smoke-backend: ${message}`);
  process.exit(code);
}

function parseArgv(argv) {
  const o = { zip: join(repoRoot, "build", "release", "runtime", "runtime.zip"), dir: "", python: "", timeoutMs: 30000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value\n${USAGE}`, 2);
      return v;
    };
    if (a === "--runtime-zip") o.zip = resolve(value());
    else if (a === "--runtime-dir") o.dir = resolve(value());
    else if (a === "--python") o.python = resolve(value());
    else if (a === "--timeout-ms") o.timeoutMs = Number(value());
    else fail(`unknown argument ${a}\n${USAGE}`, 2);
  }
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) fail(`--timeout-ms must be a positive number\n${USAGE}`, 2);
  return o;
}

function extract(zipFile, dest) {
  if (!existsSync(zipFile)) fail(`${zipFile} does not exist: build the runtime first`, 2);
  for (const e of readZip(readFileSync(zipFile))) {
    if (e.name.endsWith("/") || e.name.split("/").includes("..")) continue;
    const out = join(dest, ...e.name.split("/"));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, e.read());
  }
}

/** Resolves with { ok, detail }. */
function talk(python, backendDir, headlessDir, timeoutMs) {
  return new Promise((resolveDone) => {
    const child = spawn(python, ["-I", "-X", "utf8", join(backendDir, "server.py")], {
      cwd: backendDir,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ABF_HEADLESS_DIR: headlessDir, ABF_ABFC_TOOLS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let sentList = false;
    let exited = false;
    let settle = () => {};
    // Resolve only once the child has really exited (it holds files in the temp dir open),
    // with hard upper bounds so a stuck process cannot hang the smoke test.
    const done = (ok, detail) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let resolved = false;
      let killTimer;
      let hardTimer;
      settle = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(killTimer);
        clearTimeout(hardTimer);
        resolveDone({ ok, detail, stderr });
      };
      if (exited) return settle();
      child.stdin.end();
      killTimer = setTimeout(() => {
        child.kill();
        hardTimer = setTimeout(settle, 3000);
      }, 2000);
      child.once("exit", settle);
    };
    const timer = setTimeout(() => done(false, `no answer within ${timeoutMs} ms`), timeoutMs);
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => {
      stderr = (stderr + d.toString("utf8")).slice(-4000);
    });
    child.on("error", (e) => {
      exited = true;
      done(false, `failed to start: ${e.message}`);
    });
    child.on("exit", (code, signal) => {
      exited = true;
      done(false, `backend process exited (code ${code ?? "none"}, signal ${signal ?? "none"}) before answering`);
    });
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      let nl;
      while ((nl = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (line === "") continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.result === undefined) return done(false, `initialize returned an error: ${JSON.stringify(msg.error)}`);
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          sentList = true;
        } else if (msg.id === 2 && sentList) {
          const tools = msg.result?.tools;
          if (!Array.isArray(tools) || tools.length === 0) return done(false, `tools/list returned no tools: ${JSON.stringify(msg).slice(0, 300)}`);
          return done(true, `answered initialize and tools/list (${tools.length} tools)`);
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "abfc-smoke", version: "0.0.0" } },
    });
  });
}

async function main() {
  const o = parseArgv(process.argv.slice(2));
  const work = mkdtempSync(join(tmpdir(), "abfc-smoke-"));
  try {
    let runtime = o.dir;
    if (runtime === "") {
      runtime = join(work, "runtime");
      extract(o.zip, runtime);
    }
    const backendDir = join(runtime, "backend");
    const python = o.python !== "" ? o.python : join(runtime, "python", "python.exe");
    if (!existsSync(join(backendDir, "server.py"))) fail(`${join(backendDir, "server.py")} does not exist`, 2);
    if (!existsSync(python)) fail(`${python} does not exist`, 2);
    const headless = join(work, "headless");
    mkdirSync(headless, { recursive: true });
    const r = await talk(python, backendDir, headless, o.timeoutMs);
    if (!r.ok) {
      console.error(`smoke-backend: FAILED: ${r.detail}`);
      if (r.stderr.trim() !== "") console.error(`backend stderr (last lines):\n${r.stderr.trim().split("\n").slice(-12).join("\n")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`smoke-backend: ok: the bundled backend ${r.detail}`);
  } finally {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      console.warn(`smoke-backend: warning: could not remove ${work}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
