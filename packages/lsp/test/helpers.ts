// Shared by the lsp tests: fixture copies and an in-memory server with a framed client.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { StdioLspClient, startServer } from "../src/index.js";
import type { InitOptions } from "../src/index.js";
import { pathToUri } from "../src/uri.js";

// compiled to packages/lsp/dist/test/; temp projects sit inside that folder so that `@abfc/runtime` resolves from the repo's node_modules.
export const here = dirname(fileURLToPath(import.meta.url));
export const fixtureRoot = join(here, "..", "..", "..", "compiler", "test", "fixtures");

// The tests never read the real user config.
process.env.ABFC_USER_CONFIG = join(here, "no-user-config.json");

export const fwd = (p: string): string => p.replaceAll("\\", "/");

/** A copy of a compiler fixture with a schema-2 `abf.config.json`; `edit` may add, change or remove files. */
export function copyFixture(name: string, edit?: (dir: string) => void): string {
  const dir = mkdtempSync(join(here, "lsp-"));
  cpSync(join(fixtureRoot, name), dir, { recursive: true });
  writeFileSync(join(dir, "abf.config.json"), JSON.stringify({ schemaVersion: 2, mod: { name: "TestMod" } }), "utf8");
  edit?.(dir);
  return dir;
}

export interface Started {
  client: StdioLspClient;
  initializeResult: any;
  /** Shuts the server down (it never gets `exit`, which would end this process). */
  dispose(): Promise<void>;
}

/** A server over in-memory streams, initialised. */
export async function startInMemory(initOptions: InitOptions = {}): Promise<Started> {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  void startServer({ input: toServer, output: fromServer, log: () => undefined });
  const client = new StdioLspClient(fromServer, toServer);
  const initializeResult = await client.request("initialize", {
    processId: null,
    rootUri: null,
    capabilities: {},
    initializationOptions: { debounceMs: 0, ...initOptions },
  });
  client.notify("initialized", {});
  return {
    client,
    initializeResult,
    async dispose() {
      try {
        await client.request("shutdown", null, 5000);
      } catch {
        // already gone
      }
      client.close();
    },
  };
}

/** Sends didOpen with the text on disk; returns the document URI. */
export function open(client: StdioLspClient, file: string, text?: string): string {
  const uri = pathToUri(file);
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typescript", version: 1, text: text ?? readFileSync(file, "utf8") },
  });
  return uri;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function assertDefined<T>(v: T | undefined | null, what: string): T {
  assert.ok(v !== undefined && v !== null, what);
  return v;
}
