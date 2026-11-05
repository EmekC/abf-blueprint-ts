import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import type { Diagnostic, Profile } from "@abfc/ir";
import { envError, envWarning } from "./errors.js";
import { SETTING_INFO, resolveSetting, resolveSettingValidated } from "./settings.js";
import type { Resolved, SettingName, SettingSpec } from "./settings.js";

export interface Host {
  env: NodeJS.ProcessEnv;
  exists(p: string): boolean;
  readFile(p: string): string;
  readDir(p: string): string[];
  stat(p: string): { size: number; mtimeMs: number } | null;
  run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string };
  platform: string;
  nodeVersion: string;
}

export function realHost(): Host {
  return {
    env: process.env,
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, "utf8"),
    readDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    stat: (p) => {
      try {
        const s = statSync(p);
        return { size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        return null;
      }
    },
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { windowsHide: true, encoding: "utf8" });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") };
    },
    platform: process.platform,
    nodeVersion: process.version,
  };
}

/** Case-insensitive environment lookup (Windows semantics). */
export function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === lower) return env[k];
  return undefined;
}

function normPath(p: string): string {
  return win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();
}

function stripBom(s: string): string {
  return s.replace(/^\uFEFF/, "");
}

export interface Candidates {
  flag?: string | undefined;
  project?: string | undefined;
  user?: string | undefined;
}

function specFor(name: SettingName, c: Candidates, auto: SettingSpec<string>["auto"]): SettingSpec<string> {
  const info = SETTING_INFO[name];
  return {
    flag: c.flag,
    envNames: [...info.env],
    project: c.project,
    user: c.user,
    auto,
    labels: { flag: info.flag, project: info.project },
  };
}

// ---------------------------------------------------------------- Documents

export function findDocuments(host: Host): Resolved<string> {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
  const r = host.run("reg", ["query", key, "/v", "Personal"]);
  const tried: Resolved<string>["tried"] = [];
  const fail = (detail: string): never => {
    tried.push({ source: "registry Personal", detail });
    throw envError(
      1002,
      "Documents folder not found.",
      tried,
      'set "modsDir" in %APPDATA%\\abfc\\config.json (or ABFC_MODS_DIR) to your Abiotic Factor Mods folder.',
    );
  };
  if (r.status !== 0) return fail(`reg query failed (exit ${r.status ?? "none"})`);
  const m = /^\s*Personal\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(r.stdout);
  if (!m || !m[1]) return fail("no Personal value in the registry output");
  let unresolved: string | null = null;
  const expanded = m[1].replace(/%([^%]+)%/g, (whole, name: string) => {
    const v = getEnv(host.env, name);
    if (v === undefined) {
      unresolved = name;
      return whole;
    }
    return v;
  });
  if (unresolved !== null) return fail(`${m[1]} uses %${unresolved}% which is not set`);
  tried.push({ source: "registry Personal", detail: expanded });
  return { value: expanded, source: "auto", tried };
}

// ---------------------------------------------------------------- Editor root

interface EpicInstall { installLocation: string; appVersion: string | null }

function readManifests(host: Host, profile: Profile): { installs: EpicInstall[]; dir: string | null } {
  const programData = getEnv(host.env, "ProgramData");
  if (!programData) return { installs: [], dir: null };
  const dir = win32.join(programData, "Epic", "EpicGamesLauncher", "Data", "Manifests");
  const installs: EpicInstall[] = [];
  if (!host.exists(dir)) return { installs, dir };
  for (const f of host.readDir(dir).filter((n) => n.toLowerCase().endsWith(".item")).sort()) {
    try {
      const j = JSON.parse(stripBom(host.readFile(win32.join(dir, f)))) as Record<string, unknown>;
      if (j.DisplayName === profile.editorDisplayName && typeof j.InstallLocation === "string") {
        installs.push({
          installLocation: j.InstallLocation,
          appVersion: typeof j.AppVersionString === "string" ? j.AppVersionString : null,
        });
      }
    } catch {
      // unreadable manifest: skip it
    }
  }
  return { installs, dir };
}

export type EditorRootResult = Resolved<string> & { appVersion: string | null };

export function findEditorRoot(host: Host, profile: Profile, flag?: string, project?: string, user?: string): EditorRootResult {
  const manifests = readManifests(host, profile);
  const exeOk = (root: string): string | null =>
    host.exists(win32.join(root, profile.exeRelPath)) ? null : `no ${profile.exeRelPath} there`;

  const spec = specFor("editorRoot", { flag, project, user }, () => {
    const tried: Resolved<string>["tried"] = [];
    const manifestSource = "Epic manifests";
    if (manifests.dir === null) {
      tried.push({ source: manifestSource, detail: "ProgramData is not set" });
    } else if (manifests.installs.length === 0) {
      tried.push({ source: manifestSource, detail: `no "${profile.editorDisplayName}" in ${manifests.dir}` });
    }
    for (const inst of manifests.installs) {
      const bad = exeOk(inst.installLocation);
      if (bad === null) {
        tried.push({ source: manifestSource, detail: inst.installLocation });
        return { value: inst.installLocation, tried };
      }
      tried.push({ source: manifestSource, detail: `${inst.installLocation} (${bad})` });
    }
    const wildcardSource = "Program Files wildcard";
    const sep = profile.programFilesGlob.lastIndexOf("\\");
    const parent = sep >= 0 ? profile.programFilesGlob.slice(0, sep) : "";
    const prefix = (sep >= 0 ? profile.programFilesGlob.slice(sep + 1) : profile.programFilesGlob).replace(/\*$/, "");
    const bases = new Set<string>();
    for (const v of ["ProgramW6432", "ProgramFiles"]) {
      const b = getEnv(host.env, v);
      if (b) bases.add(b);
    }
    if (bases.size === 0) tried.push({ source: wildcardSource, detail: "ProgramFiles is not set" });
    for (const base of bases) {
      const searchDir = win32.join(base, parent);
      const hits = host.readDir(searchDir).filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase())).sort();
      if (hits.length === 0) tried.push({ source: wildcardSource, detail: `nothing matches ${win32.join(base, profile.programFilesGlob)}` });
      for (const h of hits) {
        const cand = win32.join(searchDir, h);
        const bad = exeOk(cand);
        if (bad === null) {
          tried.push({ source: wildcardSource, detail: cand });
          return { value: cand, tried };
        }
        tried.push({ source: wildcardSource, detail: `${cand} (${bad})` });
      }
    }
    return { value: null, tried };
  });

  const res = resolveSettingValidated(spec, host.env, exeOk);
  if (res.value === null) {
    throw envError(
      1001,
      `${profile.editorDisplayName} not found.`,
      res.tried,
      `install the Mod Editor from the Epic Games Launcher, or set "editor": {"root": "<folder>"} in %APPDATA%\\abfc\\config.json.`,
    );
  }
  const norm = normPath(res.value);
  const inst = manifests.installs.find((i) => normPath(i.installLocation) === norm);
  return { ...res, appVersion: inst?.appVersion ?? null };
}

// ---------------------------------------------------------------- Mods folder and mod dir

export function findModsDir(
  host: Host,
  profile: Profile,
  documents: Resolved<string> | null,
  flag?: string,
  project?: string,
  user?: string,
): Resolved<string> {
  const ok = (p: string): string | null => (host.exists(p) ? null : "folder does not exist");
  const spec = specFor("modsDir", { flag, project, user }, () => {
    if (!documents || documents.value === null) {
      return { value: null, tried: [{ source: "<Documents>", detail: "Documents folder unknown" }] };
    }
    const p = win32.join(documents.value, profile.modsFolderName);
    const bad = ok(p);
    return { value: bad === null ? p : null, tried: [{ source: "<Documents>", detail: bad === null ? p : `${p} (${bad})` }] };
  });
  const res = resolveSettingValidated(spec, host.env, ok);
  if (res.value === null) {
    throw envError(
      1003,
      `Mods folder "${profile.modsFolderName}" not found.`,
      res.tried,
      `set "modsDir" in %APPDATA%\\abfc\\config.json (or ABFC_MODS_DIR) to your "${profile.modsFolderName}" folder.`,
    );
  }
  return res;
}

export function findModDir(
  host: Host,
  modsDir: string | null,
  modName: string,
  flag?: string,
  project?: string,
  user?: string,
): Resolved<string> {
  const uplugin = (d: string): string => win32.join(d, `${modName}.uplugin`);
  const ok = (p: string): string | null => (host.exists(uplugin(p)) ? null : `no ${modName}.uplugin there`);
  const spec = specFor("modDir", { flag, project, user }, () => {
    if (modsDir === null) return { value: null, tried: [{ source: "<mods folder>", detail: "mods folder unknown" }] };
    const p = win32.join(modsDir, modName);
    const bad = ok(p);
    return { value: bad === null ? p : null, tried: [{ source: "<mods folder>", detail: bad === null ? p : `${p} (${bad})` }] };
  });
  const res = resolveSettingValidated(spec, host.env, ok);
  if (res.value === null) {
    throw envError(
      1004,
      `Mod folder for "${modName}" not found (it must hold ${modName}.uplugin).`,
      res.tried,
      'check "mod.name" in abf.config.json, or set "mod": {"dir": "<folder>"} (or ABFC_MOD_DIR).',
    );
  }
  return res;
}

// ---------------------------------------------------------------- Python

export type PythonResult = Resolved<string> & { version: string | null };

const PY_VERSION_ARGS = ["-c", "import sys;print('%d.%d'%sys.version_info[:2])"];

function pythonVersion(host: Host, exe: string): { major: number; minor: number } | null {
  const r = host.run(exe, PY_VERSION_ARGS);
  if (r.status !== 0) return null;
  const m = /^(\d+)\.(\d+)/.exec(r.stdout.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

function pythonProblem(host: Host, exe: string): string | null {
  if (/\\WindowsApps\\/i.test(exe)) return "Microsoft Store alias, not a real Python";
  const v = pythonVersion(host, exe);
  if (!v) return "does not run";
  if (v.major < 3 || (v.major === 3 && v.minor < 9)) return `Python ${v.major}.${v.minor} is older than 3.9`;
  return null;
}

export function findPython(host: Host, flag?: string, project?: string, user?: string): PythonResult {
  const spec = specFor("python", { flag, project, user }, () => {
    const tried: Resolved<string>["tried"] = [];
    const attempts: Array<{ label: string; cmd: string; args: string[] }> = [
      { label: "py -3 launcher", cmd: "py", args: ["-3", "-c", "import sys;print(sys.executable)"] },
      { label: "python on PATH", cmd: "python", args: ["-c", "import sys;print(sys.executable)"] },
    ];
    for (const a of attempts) {
      const r = host.run(a.cmd, a.args);
      const exe = r.stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
      if (r.status !== 0 || exe === "") {
        tried.push({ source: a.label, detail: "not available" });
        continue;
      }
      const bad = pythonProblem(host, exe);
      if (bad === null) {
        tried.push({ source: a.label, detail: exe });
        return { value: exe, tried };
      }
      tried.push({ source: a.label, detail: `${exe} (${bad})` });
    }
    return { value: null, tried };
  });
  const res = resolveSettingValidated(spec, host.env, (p) => pythonProblem(host, p));
  if (res.value === null) {
    throw envError(
      1005,
      "Python 3.9 or newer not found.",
      res.tried,
      'install Python 3.9+ (python.org, not the Microsoft Store alias), or set ABFC_PYTHON / "backend": {"python": "<path>"}.',
    );
  }
  const v = pythonVersion(host, res.value);
  return { ...res, version: v ? `${v.major}.${v.minor}` : null };
}

// ---------------------------------------------------------------- Backend dir

export function findBackendDir(host: Host, flag?: string, project?: string, user?: string): Resolved<string> {
  const ok = (p: string): string | null => (host.exists(win32.join(p, "server.py")) ? null : "no server.py there");
  const spec = specFor("backendDir", { flag, project, user }, () => ({
    value: null,
    tried: [{ source: "auto", detail: "no auto-discovery in Phase 1" }],
  }));
  const res = resolveSettingValidated(spec, host.env, ok);
  if (res.value === null) {
    throw envError(
      1006,
      "Backend folder not found (it must hold server.py).",
      res.tried,
      "set ABFC_BACKEND_DIR to your abf-mod-editor-mcp checkout.",
    );
  }
  return res;
}

// ---------------------------------------------------------------- Headless dir

export function findHeadlessDir(host: Host, profile: Profile, flag?: string, project?: string, user?: string): Resolved<string> {
  const spec = specFor("headlessDir", { flag, project, user }, () => {
    const local = getEnv(host.env, "LOCALAPPDATA");
    if (!local) return { value: null, tried: [{ source: "%LOCALAPPDATA%", detail: "LOCALAPPDATA is not set" }] };
    const p = win32.join(local, profile.defaultHeadlessSubdir);
    return { value: p, tried: [{ source: "%LOCALAPPDATA%", detail: p }] };
  });
  return resolveSetting(spec, host.env);
}

/** Space -> ABFC1012 (error), non-ASCII -> ABFC1013 (warning), else null. Does not throw. */
export function checkHeadlessDir(p: string): Diagnostic | null {
  if (/\s/.test(p)) {
    return {
      severity: "error",
      code: "ABFC1012",
      message:
        `the headless folder "${p}" contains a space, which the Mod Editor launch cannot handle. ` +
        `Set ABF_HEADLESS_DIR (or "headlessDir" in %APPDATA%\\abfc\\config.json) to a folder without spaces, e.g. C:\\abfc-headless.`,
    };
  }
  if (/[^\x00-\x7F]/.test(p)) {
    return envWarning(
      1013,
      `the headless folder "${p}" contains non-ASCII characters; it is unverified whether the Mod Editor launch handles them.`,
      [],
      'if the launch fails, set ABF_HEADLESS_DIR (or "headlessDir" in %APPDATA%\\abfc\\config.json) to an ASCII-only folder, e.g. C:\\abfc-headless.',
    );
  }
  return null;
}

// ---------------------------------------------------------------- Node

export function checkNode(host: Host): Diagnostic | null {
  const major = Number(/^v?(\d+)/.exec(host.nodeVersion)?.[1] ?? NaN);
  if (major === 24) return null;
  return envWarning(
    1030,
    `Node ${host.nodeVersion} is not Node 24, the supported version.`,
    [{ source: "node --version", detail: host.nodeVersion }],
    "install Node 24 (abfc is tested on it).",
  );
}
