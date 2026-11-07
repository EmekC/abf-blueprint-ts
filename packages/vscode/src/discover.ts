// Finds the abfc command for the extension (docs/design.md 18.7). Pure: no `vscode` import, so it is unit tested.
import * as path from "node:path";

export interface AbfcLaunch {
  /** The program to start: an executable path, or `node`. */
  command: string;
  /** Arguments before the abfc command line (the `.js` entry for `node`). */
  args: string[];
  source: "abfc.path" | "PATH" | "npm global" | "installer" | "workspace" | "abfc.cliPath";
}

export interface DiscoverInput {
  /** Setting `abfc.path`. */
  abfcPath?: string | undefined;
  /** Setting `abfc.cliPath`. */
  cliPath?: string | undefined;
  env: Record<string, string | undefined>;
  /** File-system paths of the workspace folders. */
  workspaceFolders: string[];
  platform: string;
  isFile: (p: string) => boolean;
  /** False in an untrusted workspace: the steps that read the opened repo (settings, workspace node_modules) are skipped. Default true. */
  trusted?: boolean | undefined;
}

export const CONFIG_FILE_NAME = "abf.config.json";

const BIN_JS_PARTS = ["node_modules", "@abfc", "cli", "dist", "src", "bin.js"];

function pathModule(platform: string): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function isScript(file: string): boolean {
  return /\.(js|mjs|cjs)$/i.test(file);
}

function nodeLaunch(file: string, source: AbfcLaunch["source"]): AbfcLaunch {
  return { command: "node", args: [file], source };
}

/** The directories of `PATH` (`Path` on Windows): quotes stripped, empty entries skipped. */
function pathDirs(i: DiscoverInput): string[] {
  const raw = i.env.PATH ?? i.env.Path ?? "";
  const sep = i.platform === "win32" ? ";" : ":";
  return raw
    .split(sep)
    .map((d) => d.trim().replaceAll('"', ""))
    .filter((d) => d !== "");
}

/**
 * Looks for abfc, first hit wins: the `abfc.path` setting, `abfc` on `PATH`, an npm global install, the installer's
 * default folder, `node_modules/@abfc/cli` in a workspace folder, the `abfc.cliPath` setting. `.js` entries start as
 * `node <file>`; a `.cmd`/`.bat` shim is never started (an `abfc.path` naming one is mapped to the `bin.js` beside it, or
 * rejected with `message`). In an untrusted workspace only `PATH`, the npm global install and the installer folder are
 * used. `tried` lists every path that was checked.
 */
export function findAbfc(i: DiscoverInput): { launch: AbfcLaunch | null; tried: string[]; message?: string } {
  const p = pathModule(i.platform);
  const win = i.platform === "win32";
  const trusted = i.trusted !== false;
  const tried: string[] = [];
  const exists = (file: string): boolean => {
    tried.push(file);
    return i.isFile(file);
  };

  // 1. the setting
  const abfcPath = i.abfcPath?.trim() ?? "";
  if (trusted && abfcPath !== "" && exists(abfcPath)) {
    if (/\.(cmd|bat)$/i.test(abfcPath)) {
      const bin = p.join(p.dirname(abfcPath), ...BIN_JS_PARTS);
      if (exists(bin)) return { launch: nodeLaunch(bin, "abfc.path"), tried };
      return {
        launch: null,
        tried,
        message: "abfc.path names a .cmd or .bat shim, which cannot be started. Point abfc.path at abfc.exe or bin.js.",
      };
    }
    return {
      launch: isScript(abfcPath) ? nodeLaunch(abfcPath, "abfc.path") : { command: abfcPath, args: [], source: "abfc.path" },
      tried,
    };
  }

  const dirs = pathDirs(i);

  // 2. the executable on PATH
  const exeName = win ? "abfc.exe" : "abfc";
  for (const dir of dirs) {
    const exe = p.join(dir, exeName);
    if (exists(exe)) return { launch: { command: exe, args: [], source: "PATH" }, tried };
  }

  // 3. an npm global install: the shim sits next to node_modules/@abfc/cli
  if (win) {
    for (const dir of dirs) {
      if (!exists(p.join(dir, "abfc.cmd"))) continue;
      const bin = p.join(dir, ...BIN_JS_PARTS);
      if (exists(bin)) return { launch: nodeLaunch(bin, "npm global"), tried };
    }
  }

  // 4. the installer's default folder
  const localAppData = i.env.LOCALAPPDATA;
  if (win && localAppData !== undefined && localAppData !== "") {
    const exe = p.join(localAppData, "Programs", "abfc", "abfc.exe");
    if (exists(exe)) return { launch: { command: exe, args: [], source: "installer" }, tried };
  }

  // 5. a source install inside a workspace folder
  for (const folder of trusted ? i.workspaceFolders : []) {
    const bin = p.join(folder, ...BIN_JS_PARTS);
    if (exists(bin)) return { launch: nodeLaunch(bin, "workspace"), tried };
  }

  // 6. the cliPath setting
  const cliPath = i.cliPath?.trim() ?? "";
  if (trusted && cliPath !== "" && exists(cliPath)) return { launch: nodeLaunch(cliPath, "abfc.cliPath"), tried };

  return { launch: null, tried };
}

/** The nearest folder at or above `file` that holds an `abf.config.json`, or null. */
export function projectDirOf(file: string, isFile: (p: string) => boolean, platform: string): string | null {
  const p = pathModule(platform);
  let dir = p.dirname(file);
  for (;;) {
    if (isFile(p.join(dir, CONFIG_FILE_NAME))) return dir;
    const parent = p.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
