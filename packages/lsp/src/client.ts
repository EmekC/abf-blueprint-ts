// A small dependency-free LSP client over framed JSON-RPC (Content-Length headers). It serves the tests, the CLI stdio test and scripts/lsp-parity.mjs.
import type { Diagnostic as LspDiagnostic } from "vscode-languageserver/node.js";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface Waiter {
  uri: string;
  pred: (ds: LspDiagnostic[]) => boolean;
  resolve: (ds: LspDiagnostic[]) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const HEADER_END = Buffer.from("\r\n\r\n");

export class StdioLspClient {
  /** Everything the server wrote that is not a valid frame (stdout must carry protocol messages only). */
  readonly protocolErrors: string[] = [];
  /** The requests the server sent (all answered with null), in order. */
  readonly serverRequests: Array<{ method: string; params: any }> = [];
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Array<(params: any) => void>>();
  private readonly latest = new Map<string, LspDiagnostic[]>();
  private readonly waiters = new Set<Waiter>();
  private closed = false;
  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    this.drain();
  };

  constructor(
    private readonly fromServer: NodeJS.ReadableStream,
    private readonly toServer: NodeJS.WritableStream,
  ) {
    fromServer.on("data", this.onData);
    this.onNotification("textDocument/publishDiagnostics", (p: { uri: string; diagnostics: LspDiagnostic[] }) => {
      this.latest.set(p.uri, p.diagnostics);
      for (const w of [...this.waiters]) {
        if (w.uri === p.uri && w.pred(p.diagnostics)) {
          this.waiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(p.diagnostics);
        }
      }
    });
  }

  private send(message: object): void {
    if (this.closed) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.toServer.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  onNotification(method: string, fn: (params: any) => void): void {
    const list = this.handlers.get(method) ?? [];
    list.push(fn);
    this.handlers.set(method, list);
  }

  /** Drops the stored publish of `uri`, so the next `waitForDiagnostics` waits for a new one. */
  forget(uri: string): void {
    this.latest.delete(uri);
  }

  /**
   * Resolves with the latest publish for `uri` (already received, or the next one) that satisfies `pred`.
   * Call `forget(uri)` first when only a publish after some action may count.
   */
  waitForDiagnostics(uri: string, pred: (ds: LspDiagnostic[]) => boolean = () => true, timeoutMs = 60_000): Promise<LspDiagnostic[]> {
    const have = this.latest.get(uri);
    if (have !== undefined && pred(have)) return Promise.resolve(have);
    return new Promise<LspDiagnostic[]>((resolve, reject) => {
      const waiter: Waiter = {
        uri,
        pred,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`no matching diagnostics for ${uri} within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  /** Stops listening and rejects what is still waiting. It does not end the streams. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fromServer.removeListener("data", this.onData);
    const err = new Error("client closed");
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.waiters.clear();
  }

  private drain(): void {
    for (;;) {
      const end = this.buffer.indexOf(HEADER_END);
      if (end < 0) {
        // No complete header yet. A buffer that cannot become a header is garbage.
        if (this.buffer.length > 0 && !looksLikeHeader(this.buffer.subarray(0, 14).toString("latin1"))) this.garbage();
        return;
      }
      const header = this.buffer.subarray(0, end).toString("latin1");
      const m = /^Content-Length: *(\d+)/im.exec(header);
      if (m === null || !looksLikeHeader(header)) {
        this.garbage();
        return;
      }
      const length = Number(m[1]);
      const start = end + HEADER_END.length;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      let message: any;
      try {
        message = JSON.parse(body);
      } catch {
        this.protocolErrors.push(`frame is not JSON: ${body.slice(0, 200)}`);
        continue;
      }
      this.dispatch(message);
    }
  }

  private garbage(): void {
    this.protocolErrors.push(`not a frame: ${this.buffer.subarray(0, 200).toString("utf8")}`);
    this.buffer = Buffer.alloc(0);
  }

  private dispatch(message: any): void {
    if (typeof message !== "object" || message === null) {
      this.protocolErrors.push(`not a message: ${JSON.stringify(message)}`);
      return;
    }
    if (message.method !== undefined && message.id !== undefined) {
      // A request from the server (client/registerCapability, workspace/configuration, ...): answer with null.
      this.serverRequests.push({ method: message.method, params: message.params });
      this.send({ id: message.id, result: null });
      return;
    }
    if (message.method !== undefined) {
      for (const fn of this.handlers.get(message.method) ?? []) fn(message.params);
      return;
    }
    const p = this.pending.get(message.id);
    if (p === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.error !== undefined) p.reject(new Error(`${p.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
    else p.resolve(message.result);
  }
}

/** True when the text starts like a Content-Length header (or could still become one). */
function looksLikeHeader(s: string): boolean {
  const name = "content-length";
  const head = s.slice(0, name.length).toLowerCase();
  return name.startsWith(head);
}
