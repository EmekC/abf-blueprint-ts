import { win32 } from "node:path";
import { BpApplyBackend } from "@abfc/backend";
import type { Backend, McpStdioClient } from "@abfc/backend";
import { loadProfile } from "@abfc/env";
import type { Environment, Host } from "@abfc/env";
import type { CliDeps } from "../src/index.js";

export type RunFn = (cmd: string, args: string[]) => { status: number; stdout: string } | undefined;

const key = (p: string): string => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

/** In-memory host: files are given up front (folders are implied), `run` is scripted, everything else is fixed. */
export function fakeHost(files: Record<string, string>, run: RunFn, env: NodeJS.ProcessEnv): Host {
  const fileMap = new Map<string, string>();
  const dirs = new Map<string, string>(); // key -> original-case name
  for (const [p, text] of Object.entries(files)) {
    fileMap.set(key(p), text);
    let cur = win32.dirname(p);
    for (;;) {
      dirs.set(key(cur), win32.basename(cur));
      const parent = win32.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  const names = new Map<string, string>();
  for (const p of Object.keys(files)) names.set(key(p), win32.basename(p));
  return {
    env,
    exists: (p) => fileMap.has(key(p)) || dirs.has(key(p)),
    readFile: (p) => {
      const t = fileMap.get(key(p));
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    readDir: (p) => {
      const base = key(p);
      const out = new Set<string>();
      for (const f of fileMap.keys()) if (key(win32.dirname(f)) === base) out.add(names.get(f) ?? win32.basename(f));
      for (const [d, name] of dirs) if (d !== base && key(win32.dirname(d)) === base) out.add(name);
      return [...out];
    },
    stat: (p) => (fileMap.has(key(p)) ? { size: fileMap.get(key(p))!.length, mtimeMs: 1000 } : null),
    run: (cmd, args) => {
      const r = run(cmd, args);
      return { status: r?.status ?? 1, stdout: r?.stdout ?? "", stderr: "" };
    },
    platform: "win32",
    nodeVersion: "v24.0.0",
  };
}

export interface FakeEnvOptions {
  username?: string;
  localAppData?: string;
  documents?: string;
  /** Sets ABF_HEADLESS_DIR. */
  headlessDir?: string;
  /** Extra project config keys merged into abf.config.json. */
  projectConfig?: Record<string, unknown>;
  /** Extra files (path -> text). */
  extraFiles?: Record<string, string>;
}

export interface FakeEnvironment {
  files: Record<string, string>;
  env: NodeJS.ProcessEnv;
  run: RunFn;
  projectDir: string;
  documents: string;
  editorRoot: string;
  modDir: string;
  backendDir: string;
  headlessDefault: string;
  host: () => Host;
}

const PYTHON_EXE = "C:\\Python311\\python.exe";

/**
 * A synthetic machine: Epic manifest with the profile's display name, the editor exe, a mods folder with `TestMod.uplugin`,
 * a backend folder with `server.py`, Python 3.11 behind the `py` launcher, and a project folder with `abf.config.json`.
 */
export function fakeEnvironmentFiles(o: FakeEnvOptions = {}): FakeEnvironment {
  const profile = loadProfile();
  const username = o.username ?? "Jane";
  const localAppData = o.localAppData ?? "C:\\Users\\Jane\\AppData\\Local";
  const documents = o.documents ?? "C:\\Users\\Jane\\Documents";
  const editorRoot = "C:\\Epic\\ModEdit_X1";
  const modsDir = win32.join(documents, profile.modsFolderName);
  const modDir = win32.join(modsDir, "TestMod");
  const backendDir = "C:\\Backend\\mcp";
  const projectDir = "C:\\Work\\proj";
  const projectConfig: Record<string, unknown> = {
    schemaVersion: 2,
    mod: { name: "TestMod" },
    backend: { kind: "bp_apply", minProtocol: 1 },
    ...(o.projectConfig ?? {}),
  };
  // Schema 2 writes mod-relative modAssets; tests may keep passing "/TestMod/X".
  const stubsCfg = projectConfig.stubs as { modAssets?: unknown } | undefined;
  if (stubsCfg !== undefined && Array.isArray(stubsCfg.modAssets)) {
    projectConfig.stubs = {
      ...stubsCfg,
      modAssets: (stubsCfg.modAssets as string[]).map((a) => (a.startsWith("/TestMod/") ? a.slice("/TestMod/".length) : a)),
    };
  }
  const files: Record<string, string> = {
    "C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests\\A1.item": JSON.stringify({
      DisplayName: profile.editorDisplayName,
      InstallLocation: editorRoot,
      AppVersionString: `build-${profile.buildTag}`,
    }),
    [win32.join(editorRoot, profile.exeRelPath)]: "exe",
    [win32.join(modDir, "TestMod.uplugin")]: "{}",
    [win32.join(backendDir, "server.py")]: "# server",
    [win32.join(projectDir, "abf.config.json")]: JSON.stringify(projectConfig),
    ...(o.extraFiles ?? {}),
  };
  const env: NodeJS.ProcessEnv = {
    USERNAME: username,
    USERPROFILE: win32.dirname(win32.dirname(localAppData)),
    LOCALAPPDATA: localAppData,
    ProgramData: "C:\\ProgramData",
    ProgramFiles: "C:\\Program Files",
    ABFC_BACKEND_DIR: backendDir,
  };
  if (o.headlessDir !== undefined) env.ABF_HEADLESS_DIR = o.headlessDir;
  const run: RunFn = (cmd, args) => {
    if (cmd === "reg" && args.includes("Personal")) {
      return {
        status: 0,
        stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    Personal    REG_SZ    ${documents}\r\n`,
      };
    }
    if (cmd === "py") return { status: 0, stdout: PYTHON_EXE + "\r\n" };
    if (cmd === PYTHON_EXE) return { status: 0, stdout: "3.11\r\n" };
    return undefined;
  };
  return {
    files,
    env,
    run,
    projectDir,
    documents,
    editorRoot,
    modDir,
    backendDir,
    headlessDefault: win32.join(localAppData, profile.defaultHeadlessSubdir),
    host: () => fakeHost(files, run, env),
  };
}

export const ALL_TOOLS = [
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
];

/** `backend_info` in the shape of the wildcard-pins branch. */
export function fixInfo(
  over: {
    protocol?: number;
    serverVersion?: string;
    headlessDir?: string;
    documentsDir?: string;
    pinTypes?: boolean;
    /** Extra raw `capabilities` keys (e.g. the 2.6.0 ones). */
    capabilities?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    protocol: over.protocol ?? 1,
    serverVersion: over.serverVersion ?? "fake-1",
    editorRoot: null,
    headlessDir: over.headlessDir ?? "C:\\abfc-headless",
    documentsDir: over.documentsDir ?? "C:\\Users\\Jane\\Documents",
    capabilities: { pinTypes: over.pinTypes ?? true, containerTypes: { array: true, map: true, set: false }, ...over.capabilities },
    bpApply: { features: ["cast_object_pin", "map_types", "pin_types", "self_event_calls", "variable_defaults"], nodeKinds: ["call", "cast"] },
  };
}

/** A real `BpApplyBackend` over a scripted client: `tools` is the tool list, `replies` the JSON per tool name. */
export function scriptedBackend(tools: string[], replies: Record<string, unknown>): Backend {
  const client = {
    listTools: async (): Promise<string[]> => tools,
    callTool: async (name: string) => {
      const reply = replies[name];
      if (reply === undefined) throw new Error(`scripted client: no reply for ${name}`);
      return { isError: false, text: JSON.stringify(reply), json: reply, wallSeconds: 0 };
    },
    close: async (): Promise<void> => {},
  } as unknown as McpStdioClient;
  return new BpApplyBackend(client, { serverDir: "C:\\Backend\\mcp" });
}

export interface Captured {
  deps: CliDeps;
  /** stdout and stderr lines in order. */
  lines: string[];
  text: () => string;
  started: { count: number };
}

export function captureDeps(fake: FakeEnvironment, backend: (env: Environment) => Promise<Backend>): Captured {
  const lines: string[] = [];
  const started = { count: 0 };
  const deps: CliDeps = {
    host: fake.host(),
    startBackend: async (env) => {
      started.count++;
      return backend(env);
    },
    now: () => new Date(2026, 0, 2, 3, 4, 5),
    cwd: fake.projectDir,
    stdout: (l) => lines.push(l),
    stderr: (l) => lines.push(l),
  };
  return { deps, lines, text: () => lines.join("\n"), started };
}

export interface MutableCaptured extends Captured {
  /** The files of the fake machine; `deps.fs.writeFile` updates them. */
  files: Record<string, string>;
  /** Absolute path of every file written through `deps.fs`, in order. */
  writes: string[];
}

/**
 * Like {@link captureDeps}, but the host follows the writes of `deps.fs` (what `abfc init` writes can be read back by the
 * commands it runs afterwards). `deps.interactive` is false until a test sets it.
 */
export function mutableCapture(fake: FakeEnvironment, backend: (env: Environment) => Promise<Backend>): MutableCaptured {
  const cap = captureDeps(fake, backend);
  const files = fake.files;
  const writes: string[] = [];
  let current = fakeHost(files, fake.run, fake.env);
  cap.deps.host = {
    env: fake.env,
    exists: (p) => current.exists(p),
    readFile: (p) => current.readFile(p),
    readDir: (p) => current.readDir(p),
    stat: (p) => current.stat(p),
    run: (cmd, args) => current.run(cmd, args),
    platform: "win32",
    nodeVersion: "v24.0.0",
  };
  cap.deps.fs = {
    writeFile: (p, text) => {
      const existing = Object.keys(files).find((k) => key(k) === key(p));
      files[existing ?? p] = text;
      writes.push(p);
      current = fakeHost(files, fake.run, fake.env);
    },
    mkdir: () => {},
  };
  cap.deps.interactive = false;
  return Object.assign(cap, { files, writes });
}
