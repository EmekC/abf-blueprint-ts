// The "Generate stubs" quick fix: runs `abfc generate --add ...` as a child process (never on keystrokes, only on the explicit command).
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { pathKey } from "./uri.js";

/** The LSP command of the quick fix (`workspace/executeCommand`). */
export const GENERATE_STUBS_COMMAND = "abfc.generateStubs";

/** How the server starts the abfc CLI (given by `abfc lsp`; without it no quick fix is offered). */
export interface CliLaunch {
  command: string;
  args: string[];
}

/** The minimal child process surface used here, so tests can pass a fake. */
export interface StubsChild {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "error", listener: (e: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => StubsChild;

export interface GenerateResult {
  ok: boolean;
  message: string;
}

/** Projects with a run in flight (one `abfc generate` per project at a time). */
const running = new Set<string>();

const lastLine = (text: string): string => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "").pop() ?? "";

interface Envelope {
  ok?: unknown;
  diagnostics?: unknown;
  result?: unknown;
}

function parseEnvelope(stdout: string): Envelope | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    const v: unknown = JSON.parse(stdout.slice(start));
    return typeof v === "object" && v !== null ? (v as Envelope) : null;
  } catch {
    return null;
  }
}

const firstError = (diagnostics: unknown): string | null => {
  if (!Array.isArray(diagnostics)) return null;
  for (const d of diagnostics as Array<{ severity?: unknown; code?: unknown; message?: unknown }>) {
    if (d !== null && typeof d === "object" && d.severity === "error" && typeof d.message === "string") {
      return typeof d.code === "string" ? `${d.code}: ${d.message}` : d.message;
    }
  }
  return null;
};

/** The names `abfc generate` could not find (ABFC3022 warnings), as one short sentence part; empty when none. */
const notFoundOf = (envelope: Envelope): string[] => {
  const r = envelope.result;
  if (typeof r !== "object" || r === null) return [];
  const nf = (r as { notFound?: unknown }).notFound;
  return Array.isArray(nf) ? nf.filter((x): x is string => typeof x === "string") : [];
};

/**
 * Runs `abfc generate --project <dir> --json --add <a>...` and reports how it went. The CLI takes the project lock itself, so a
 * parallel build ends with its ABFC4019 error here (shown to the user), never with a half-written stub folder.
 */
export function runGenerateStubs(launch: CliLaunch, projectDir: string, add: string[], spawnFn: SpawnFn = spawn as unknown as SpawnFn): Promise<GenerateResult> {
  const key = pathKey(projectDir);
  if (running.has(key)) return Promise.resolve({ ok: false, message: "abfc generate is already running for this project" });
  running.add(key);
  const what = add.join(", ");
  return new Promise<GenerateResult>((resolve) => {
    let settled = false;
    const finish = (r: GenerateResult): void => {
      if (settled) return;
      settled = true;
      running.delete(key);
      resolve(r);
    };
    let child: StubsChild;
    try {
      child = spawnFn(launch.command, [...launch.args, "generate", "--project", projectDir, "--json", ...add.map((a) => `--add=${a}`)], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      finish({ ok: false, message: `could not start abfc generate: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (e) => finish({ ok: false, message: `could not start abfc generate: ${e.message}` }));
    child.on("close", (code) => {
      const envelope = parseEnvelope(stdout);
      if (envelope !== null) {
        if (envelope.ok === true) {
          const missing = notFoundOf(envelope);
          if (missing.length > 0) {
            finish({ ok: false, message: `abfc: nothing generated for ${missing.join(", ")} (not a class, struct or enum of this editor build)` });
            return;
          }
          const generated = (envelope.result as { reflected?: unknown } | null | undefined)?.reflected;
          finish({ ok: true, message: generated === 0 ? `abfc: stubs for ${what} are already up to date` : `abfc: stubs generated for ${what}` });
          return;
        }
        finish({ ok: false, message: firstError(envelope.diagnostics) ?? (lastLine(stderr) || `abfc generate failed (exit code ${code ?? "?"})`) });
        return;
      }
      finish({ ok: false, message: lastLine(stderr) || `abfc generate failed (exit code ${code ?? "?"})` });
    });
  });
}
