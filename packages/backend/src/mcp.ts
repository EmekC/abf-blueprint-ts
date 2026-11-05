import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { AbfcError } from "@abfc/env";
import { assertToolAllowed } from "./safety.js";

export interface McpStartOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
  /** How long `close()` waits for the process to exit after closing stdin before it kills the tree (default 30000). */
  closeGraceMs?: number;
}

export interface McpToolResult {
  isError: boolean;
  text: string;
  json: unknown | undefined;
  wallSeconds: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

const liveClients = new Set<McpStdioClient>();
const CLIENT_VERSION = "0.1.0";

export class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private exited = false;
  private readonly exitWaiters: Array<() => void> = [];
  private readonly requestTimeoutMs: number;
  private readonly closeGraceMs: number;

  private constructor(child: ChildProcessWithoutNullStreams, o: McpStartOptions) {
    this.child = child;
    this.requestTimeoutMs = o.requestTimeoutMs ?? 30_000;
    this.closeGraceMs = o.closeGraceMs ?? 30_000;

    child.stdout.setEncoding("utf8");
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.onLine(line));
    child.stderr.setEncoding("utf8");
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => o.onStderr?.(line));
    child.stdin.on("error", () => {
      // the process went away; pending requests are rejected by the exit handler
    });
    child.on("error", (err) => this.onExit(`failed to start: ${err.message}`));
    child.on("exit", (code, signal) => this.onExit(`exited (code ${code ?? "none"}, signal ${signal ?? "none"})`));
  }

  static async start(o: McpStartOptions): Promise<McpStdioClient> {
    const child = spawn(o.command, o.args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new McpStdioClient(child, o);
    liveClients.add(client);
    try {
      await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "abfc", version: CLIENT_VERSION },
      });
      client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch (e) {
      await client.close();
      throw e;
    }
    return client;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  async listTools(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: Array<{ name?: unknown }>;
        nextCursor?: unknown;
      };
      for (const t of res.tools ?? []) if (typeof t.name === "string") names.push(t.name);
      if (typeof res.nextCursor === "string" && res.nextCursor !== "") cursor = res.nextCursor;
      else break;
    }
    return names;
  }

  async callTool(name: string, args: Record<string, unknown>, o?: { timeoutMs?: number }): Promise<McpToolResult> {
    assertToolAllowed(name);
    const secs = typeof args.timeout_seconds === "number" ? args.timeout_seconds : 600;
    const timeoutMs = o?.timeoutMs ?? (secs + 60) * 1000;
    const t0 = Date.now();
    let res: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    try {
      res = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as typeof res;
    } catch (e) {
      if (e instanceof McpRpcError) {
        throw new AbfcError({
          severity: "error",
          code: "ABFC4002",
          message: `backend tool "${name}" failed: ${e.message}`,
        });
      }
      throw e;
    }
    const wallSeconds = Math.round(((Date.now() - t0) / 1000) * 100) / 100;
    const text = (res.content ?? []).map((c) => c.text ?? `<${c.type ?? "unknown"}>`).join("\n");
    let json: unknown | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: res.isError === true, text, json, wallSeconds };
  }

  async close(): Promise<void> {
    liveClients.delete(this);
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    const gone = await this.waitForExit(this.closeGraceMs);
    if (!gone) {
      killTree(this.child.pid);
      await this.waitForExit(5000);
    }
  }

  // ------------------------------------------------------------ internals

  private send(msg: Record<string, unknown>): void {
    if (this.exited) throw new Error("backend process has exited");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new Error(`backend process has exited (cannot send ${method})`));
        return;
      }
      const id = ++this.nextId;
      const ms = timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out after ${ms} ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // not JSON: ignore
    }
    if (typeof msg.id !== "number") return; // notifications and server requests are ignored
    const p = this.pending.get(msg.id);
    if (!p) return; // not ours (or already timed out)
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) {
      const m = typeof msg.error?.message === "string" ? msg.error.message : JSON.stringify(msg.error);
      p.reject(new McpRpcError(m));
    } else {
      p.resolve(msg.result);
    }
  }

  private onExit(why: string): void {
    if (this.exited) return;
    this.exited = true;
    liveClients.delete(this);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`backend process ${why} before answering ${p.method}`));
      this.pending.delete(id);
    }
    for (const w of this.exitWaiters.splice(0)) w();
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.exitWaiters.indexOf(done);
        if (i >= 0) this.exitWaiters.splice(i, 1);
        resolve(false);
      }, ms);
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.exitWaiters.push(done);
    });
  }
}

export class McpRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRpcError";
  }
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}

let handlersInstalled = false;

/** Closes every live client on SIGINT/SIGTERM, then exits with 130. Safe to call more than once. */
export function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const onSignal = (): void => {
    void Promise.allSettled([...liveClients].map((c) => c.close())).then(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

export function liveClientCount(): number {
  return liveClients.size;
}

export interface BackendServerEnv {
  python: string;
  backendDir: string;
  headlessDir: string;
  editorRoot: string | null;
}

/** Starts the abf-mod-editor-mcp `server.py` over stdio with abfc's environment. */
export function spawnBackendServer(
  env: BackendServerEnv,
  o?: Pick<McpStartOptions, "requestTimeoutMs" | "onStderr" | "closeGraceMs">,
): Promise<McpStdioClient> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  childEnv.PYTHONUTF8 = "1";
  childEnv.PYTHONIOENCODING = "utf-8";
  childEnv.ABF_HEADLESS_DIR = env.headlessDir;
  childEnv.ABF_ABFC_TOOLS = "1";
  if (env.editorRoot) childEnv.ABF_EDITOR_ROOT = env.editorRoot;
  return McpStdioClient.start({
    command: env.python,
    args: ["-I", "-X", "utf8", join(env.backendDir, "server.py")],
    cwd: env.backendDir,
    env: childEnv,
    ...o,
  });
}
