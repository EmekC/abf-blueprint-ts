import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envError } from "./errors.js";
import { USER_CONFIG_LABEL } from "./settings.js";

export interface ProjectConfig {
  mod: { name: string; dir?: string };
  stubs: { classes: string[]; scriptClasses: string[]; modAssets: "all" | string[]; scriptModules?: string[] };
  backend: { kind: "bp_apply"; minProtocol: number; serverDir?: string; python?: string };
  editor?: { root?: string };
  headlessDir?: string;
  modsDir?: string;
}

export const PROJECT_CONFIG_FILE = "abf.config.json";

export interface ConfigFiles {
  exists(p: string): boolean;
  readFile(p: string): string;
}

const nodeFiles: ConfigFiles = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
};

type Obj = Record<string, unknown>;

function fail(file: string, path: string, problem: string): never {
  throw envError(
    1021,
    `${file} is invalid at ${path}: ${problem}.`,
    [{ source: file, detail: `${path}: ${problem}` }],
    `fix "${path}" in ${file} (UTF-8 JSON).`,
  );
}

function parseJson(file: string, text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    return fail(file, "$", `not valid JSON (${(e as Error).message})`);
  }
}

function asObj(file: string, path: string, v: unknown): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(file, path, "expected an object");
  return v as Obj;
}

function optStr(file: string, o: Obj, key: string, path: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") return fail(file, `${path}${key}`, "expected a non-empty string");
  return v;
}

function strArray(file: string, o: Obj, key: string, path: string): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return fail(file, `${path}${key}`, "expected an array of strings");
  return v as string[];
}

function parseConfig(file: string, raw: unknown, partial: boolean): Partial<ProjectConfig> {
  const root = asObj(file, "$", raw);
  const out: Partial<ProjectConfig> = {};

  if (root.mod !== undefined || !partial) {
    const m = asObj(file, "mod", root.mod);
    const name = m.name;
    // The user config may carry just `mod.dir`; the name is only required (and only read) from the project config.
    const nameOptional = partial && name === undefined;
    if (!nameOptional && (typeof name !== "string" || name === "")) fail(file, "mod.name", "expected a non-empty string");
    const mod = (nameOptional ? {} : { name: name as string }) as ProjectConfig["mod"];
    const dir = optStr(file, m, "dir", "mod.");
    if (dir !== undefined) mod.dir = dir;
    out.mod = mod;
  }

  if (root.stubs !== undefined) {
    const s = asObj(file, "stubs", root.stubs);
    const modAssets = s.modAssets;
    if (modAssets !== undefined && modAssets !== "all" && (!Array.isArray(modAssets) || modAssets.some((x) => typeof x !== "string"))) {
      fail(file, "stubs.modAssets", 'expected "all" or an array of strings');
    }
    const stubs: ProjectConfig["stubs"] = {
      classes: strArray(file, s, "classes", "stubs.") ?? [],
      scriptClasses: strArray(file, s, "scriptClasses", "stubs.") ?? [],
      modAssets: (modAssets as "all" | string[] | undefined) ?? "all",
    };
    const scriptModules = strArray(file, s, "scriptModules", "stubs.");
    if (scriptModules !== undefined) stubs.scriptModules = scriptModules;
    out.stubs = stubs;
  } else if (!partial) {
    out.stubs = { classes: [], scriptClasses: [], modAssets: "all" };
  }

  if (root.backend !== undefined) {
    const b = asObj(file, "backend", root.backend);
    const kind = b.kind ?? "bp_apply";
    if (kind !== "bp_apply") fail(file, "backend.kind", 'only "bp_apply" is supported');
    const minProtocol = b.minProtocol ?? 1;
    if (typeof minProtocol !== "number" || !Number.isInteger(minProtocol) || minProtocol < 1) {
      fail(file, "backend.minProtocol", "expected a positive integer");
    }
    const backend: ProjectConfig["backend"] = { kind: "bp_apply", minProtocol: minProtocol as number };
    const serverDir = optStr(file, b, "serverDir", "backend.");
    if (serverDir !== undefined) backend.serverDir = serverDir;
    const python = optStr(file, b, "python", "backend.");
    if (python !== undefined) backend.python = python;
    out.backend = backend;
  } else if (!partial) {
    out.backend = { kind: "bp_apply", minProtocol: 1 };
  }

  if (root.editor !== undefined) {
    const e = asObj(file, "editor", root.editor);
    const editor: NonNullable<ProjectConfig["editor"]> = {};
    const r = optStr(file, e, "root", "editor.");
    if (r !== undefined) editor.root = r;
    out.editor = editor;
  }
  const headlessDir = optStr(file, root, "headlessDir", "");
  if (headlessDir !== undefined) out.headlessDir = headlessDir;
  const modsDir = optStr(file, root, "modsDir", "");
  if (modsDir !== undefined) out.modsDir = modsDir;
  return out;
}

/** Reads `<projectDir>/abf.config.json` (UTF-8, BOM tolerated). ABFC1021 when missing or invalid. */
export function loadProjectConfig(projectDir: string, files: ConfigFiles = nodeFiles): ProjectConfig {
  const file = join(projectDir, PROJECT_CONFIG_FILE);
  if (!files.exists(file)) {
    throw envError(
      1021,
      `${PROJECT_CONFIG_FILE} not found in ${projectDir}.`,
      [{ source: PROJECT_CONFIG_FILE, detail: `no file at ${file}` }],
      `create ${PROJECT_CONFIG_FILE} with at least {"mod": {"name": "<your mod>"}}.`,
    );
  }
  return parseConfig(PROJECT_CONFIG_FILE, parseJson(PROJECT_CONFIG_FILE, files.readFile(file)), false) as ProjectConfig;
}

/** Reads `%APPDATA%\abfc\config.json`; null when `APPDATA` is unset or the file does not exist. */
export function loadUserConfig(env: NodeJS.ProcessEnv, files: ConfigFiles = nodeFiles): Partial<ProjectConfig> | null {
  const appData = env.APPDATA;
  if (!appData) return null;
  const file = join(appData, "abfc", "config.json");
  if (!files.exists(file)) return null;
  return parseConfig(USER_CONFIG_LABEL, parseJson(USER_CONFIG_LABEL, files.readFile(file)), true);
}

/** Machine-specific keys that should live in the user config, not the (committed) project config. */
export function machineKeysInProject(cfg: Partial<ProjectConfig>): string[] {
  const keys: string[] = [];
  if (cfg.editor?.root !== undefined) keys.push("editor.root");
  if (cfg.modsDir !== undefined) keys.push("modsDir");
  if (cfg.headlessDir !== undefined) keys.push("headlessDir");
  if (cfg.mod?.dir !== undefined) keys.push("mod.dir");
  if (cfg.backend?.serverDir !== undefined) keys.push("backend.serverDir");
  if (cfg.backend?.python !== undefined) keys.push("backend.python");
  return keys;
}
