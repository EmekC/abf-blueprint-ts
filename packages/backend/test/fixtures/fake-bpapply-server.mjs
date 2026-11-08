// Fake abf-mod-editor-mcp for the BpApplyBackend tests (line protocol, one JSON object per line).
// Env: FAKE_LOG    = file that receives one JSON line per tools/call ({tool, args}).
//      FAKE_CONFIG = JSON {tools?: string[], backendInfo?: object | null, extensions?: object | null}
//                    tools: tool names to list (default: every tool below); backendInfo null removes the tool.
//      FAKE_DIR    = folder for reflect.json.
// Special mods: "ghost" is not staged, "broken" makes staging_status fail otherwise, "failmod" fails bp_apply with a
// compile error (rolled back), "memswap" fails bp_apply like the memory-swap writer, "badspec" fails validation,
// "crash" returns a traceback text.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";

const config = JSON.parse(process.env.FAKE_CONFIG ?? "{}");
const dir = process.env.FAKE_DIR ?? tmpdir();

const BACKEND_INFO = {
  protocol: 1,
  serverVersion: "fake-2",
  editorRoot: null,
  headlessDir: "C:\\fake-headless",
  documentsDir: "C:\\fake-docs",
  capabilities: { pinTypes: true, containerTypes: { array: true, map: true, set: false }, warmSession: true, stageAudit: true },
  bpApply: { features: ["cast_object_pin", "map_types", "pin_types"], nodeKinds: ["call", "cast", "event"] },
};
const EXTENSIONS = {
  extProtocol: 1,
  serverVersion: "fake-2",
  python: "3.11.9",
  features: ["reflect", "compile_node_refs", "bp_read_seconds"],
};

const ALL = [
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
  "warm_session",
  "bp_publish",
  "bp_asset_ops",
];
let warmRunning = false;
const listed = config.tools ?? ALL;
const backendInfo = "backendInfo" in config ? config.backendInfo : BACKEND_INFO;
const extensions = "extensions" in config ? config.extensions : EXTENSIONS;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });
const json = (o, isError = false) => text(JSON.stringify(o, null, 2), isError);

function callTool(name, args) {
  switch (name) {
    case "backend_info":
      return backendInfo === null ? text("Unknown tool backend_info", true) : json(backendInfo);
    case "abfc_extensions":
      return extensions === null ? text("Unknown tool abfc_extensions", true) : json(extensions);
    case "warm_session":
      warmRunning = args.action === "start";
      return json({ running: warmRunning });
    case "staging_sync":
      warmRunning = false;
      return json({ mod: "TestMod", files: 7, staging_path: "C:\\fake\\stage\\TestMod", message: "Staged TestMod." });
    case "staging_status":
      if (args.mod === "ghost") return text("mod ghost is not staged: run staging_sync first", true);
      if (args.mod === "broken") return text("disk on fire", true);
      return json({
        mod: args.mod,
        staging_path: "C:\\fake\\stage\\" + args.mod,
        source_dir: "C:\\fake\\mods\\" + args.mod,
        synced_at: "2026-01-02T03:04:05Z",
        changed: ["Content/A.uasset"],
        added: [],
        removed: ["Content/B.uasset"],
        conflicts: args.mod === "conflicted" ? [{ path: "Content/C.uasset", reason: "the real file changed since the last sync; run staging_sync again" }] : [],
        kit_found: true,
      });
    case "bp_apply": {
      const specs = JSON.parse(readFileSync(args.spec_file, "utf8"));
      const run = "C:\\fake\\runs\\apply-1";
      if (args.mod === "failmod")
        return json(
          {
            ok: false,
            rolled_back: true,
            assets: null,
            compile: {
              errors: [
                { asset: "/TestMod/BP_A", message: "Bad pin", source: "/TestMod/BP_A.BP_A:EventGraph.K2Node_CallFunction_3", graph: "EventGraph", node: "K2Node_CallFunction_3" },
                { asset: "/TestMod/BP_A", message: "Plain error" },
              ],
              warnings: [],
            },
            problems: [],
            run,
            seconds: 12.5,
            error: "2 compile error(s) in the edited assets",
            log_tail: "tail line",
            note: "The staged files were restored to their state before this call.",
          },
          true,
        );
      if (args.mod === "memswap")
        return json({ ok: false, rolled_back: true, assets: null, compile: { errors: [], warnings: [] }, run, seconds: 1, error: "Nodes array not found in the imported graph" }, true);
      if (args.mod === "badspec") return json({ ok: false, error: "invalid spec", problems: ["assets[0]: missing asset"] }, true);
      if (args.mod === "crash") return text("Traceback (most recent call last):\n  File x\nRuntimeError: kaboom", true);
      return json({
        ok: true,
        rolled_back: false,
        assets: specs.map((s) => ({ asset: s.asset, node_ids: { EventGraph: { ev: "K2Node_CustomEvent_0" } }, final: "final_0.t3d" })),
        compile: { errors: [], warnings: [{ asset: "/TestMod/BP_A", message: "careful" }] },
        problems: [],
        run,
        seconds: 9.25,
      });
    }
    case "bp_read":
      return json({ blueprint: "BP_A", graphs: {}, asset: args.asset_path, run: "C:\\fake\\runs\\read-1", seconds: 4.2, warm: warmRunning });
    case "bp_compile_report":
      return json({
        warm: warmRunning,
        clean: false,
        unchecked: [],
        error_count: 1,
        warning_count: 1,
        assets: {},
        messages: [
          { severity: "error", asset: "/TestMod/BP_A", message: "Bad pin", node: "K2Node_CallFunction_3", graph: "EventGraph" },
          { severity: "warning", asset: "/TestMod/BP_A", message: "careful", node: null, graph: null },
        ],
        compiled: 1,
        skipped: 0,
        run: "C:\\fake\\runs\\compile-1",
        seconds: 6,
      });
    case "reflect": {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "reflect.json");
      writeFileSync(
        file,
        "\uFEFF" +
          JSON.stringify({
            engineVersion: "5.4.4-fake",
            classes: { "/Script/Fake.Widget": { meta: "/Script/CoreUObject.Class", ancestors: [], functions: [], properties: [], castPin: "AsWidget" } },
            structs: {},
            errors: ["one member failed"],
            ...(args.gameplay_tags === true ? { gameplayTags: { tags: ["ClassManager.EntityDirector.Fake"], sources: { settings: 1 } } } : {}),
            ...(Array.isArray(args.supers_of) ? { supers: { "/Script/Fake.Widget": ["/Script/Fake.Base", "/Script/CoreUObject.Object"], "/Script/Fake.Bad": [1] } } : {}),
          }),
        "utf8",
      );
      return json({
        ok: true,
        run: "C:\\fake\\runs\\reflect-1",
        seconds: 40.5,
        file,
        counts: { classes: 1, functions: 0, properties: 0, structs: 0, errors: 1 },
        filter: { content_version: "v1", rules: [["Allow", "Fake.Widget"], ["Block", "Fake.Widget.Secret"]] },
      });
    }
    case "bp_asset_ops": {
      const ops = args.ops ?? [];
      if (ops.some((o) => o.op === "delete" && o.asset === "/TestMod/Referenced")) {
        return json({ ok: false, results: [{ op: "delete", ok: false, detail: "referenced by /TestMod/Other" }], touched: [], error: "delete failed: referenced by /TestMod/Other", rolled_back: true, run: "C:\fake\runs\ops-1" }, true);
      }
      return json({ ok: true, results: ops.map((o) => ({ op: o.op, ok: true })), touched: ["/TestMod/Row"], run: "C:\fake\runs\ops-1", error: null });
    }
    case "bp_publish":
      return json({ ok: true, published: ["Content/A.uasset"], deleted: args.delete_removed === true ? ["Content/Old.uasset"] : [], message: "published", backup: "C:\fake\backup", route: "file-copy" });
    case "bp_game_test":
      return json(
        {
          ok: false,
          steps: [
            { i: 0, op: "python", ok: true, value: "R=True" },
            { i: 1, op: "assert", ok: false, value: "R=False", error: "expected True" },
          ],
          passed: 1,
          failed: 1,
          complete: true,
          runtime_log: ["LogScript: Warning: something"],
          notes: [],
          run: "C:\\fake\\runs\\game-1",
          seconds: 30,
          timed_out: false,
          error: "1 step(s) failed",
        },
        true,
      );
    case "mod_audit":
      return json({ ok: true, completed: true, errors: 0, warnings: 2, audited: 5, lines: [], compile: { errors: [], warnings: [] }, run: "C:\\fake\\runs\\audit-1", seconds: 45 });
    default:
      return null;
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "2" } } });
  } else if (msg.method === "tools/list") {
    const tools = listed.map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } }));
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    const name = msg.params.name;
    const args = msg.params.arguments ?? {};
    if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: name, args }) + "\n");
    const res = listed.includes(name) ? callTool(name, args) : null;
    send({ jsonrpc: "2.0", id: msg.id, result: res ?? text(`Unknown tool ${name}`, true) });
  }
});
rl.on("close", () => process.exit(0));
