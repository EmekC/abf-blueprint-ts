// Fake MCP stdio server for the client tests (line protocol, one JSON object per line).
// Env: FAKE_LOG = file that receives one JSON line per received message ({method, tool?}).
//      FAKE_IGNORE_STDIN_END = "1" keeps the process alive after stdin closes (forces the kill path).
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (entry) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
};

const BACKEND_INFO = {
  protocol: 1,
  serverVersion: "fake-1",
  editorRoot: null,
  headlessDir: "C:\\fake-headless",
  documentsDir: "C:\\fake-docs",
  capabilities: { pinTypes: true, containerTypes: { array: true, map: true, set: false } },
  bpApply: { features: ["cast_object_pin", "map_types", "pin_types"], nodeKinds: ["call", "cast", "event"] },
};

const TOOLS = ["backend_info", "echo", "bp_publish", "slow"].map((name) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
}));

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  const msg = JSON.parse(line);
  log({ method: msg.method, tool: msg.params?.name });
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  } else if (msg.method === "tools/list") {
    // a stray line that is not a reply to anything must be ignored by the client
    send({ jsonrpc: "2.0", method: "notifications/message", params: { data: "noise" } });
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    const name = msg.params.name;
    const args = msg.params.arguments ?? {};
    if (name === "backend_info" && args.hang) return; // never replies
    if (name === "backend_info" && args.plain) return send({ jsonrpc: "2.0", id: msg.id, result: text("not json") });
    if (name === "backend_info" && args.fail) return send({ jsonrpc: "2.0", id: msg.id, result: text("boom", true) });
    if (name === "backend_info") return send({ jsonrpc: "2.0", id: msg.id, result: text(JSON.stringify(BACKEND_INFO)) });
    if (name === "echo") return send({ jsonrpc: "2.0", id: msg.id, result: text(JSON.stringify(args)) });
    if (name === "slow") return; // never replies
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown tool ${name}` } });
  }
});
rl.on("close", () => {
  if (process.env.FAKE_IGNORE_STDIN_END === "1") {
    setInterval(() => {}, 1000);
  } else {
    process.exit(0);
  }
});
