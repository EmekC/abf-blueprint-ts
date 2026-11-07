// `abfc init` (docs/design.md 18.5): links a TypeScript project folder to one existing mod. Dispatched before the
// project lookup, so it works without an abf.config.json. Everything is decided first (a plan of file operations),
// then written through `CliDeps.fs`.
import { mkdirSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import type { Diagnostic, Profile } from "@abfc/ir";
import {
  AbfcError,
  PROJECT_CONFIG_FILE,
  assertNotInModFolder,
  envError,
  envWarning,
  findDocuments,
  findEditorRoot,
  findModsDir,
  loadProfile,
  loadProjectConfig,
  loadUserConfig,
  migrateProjectConfigText,
  profileForBuild,
  scanMods,
  updateUserConfigText,
  userConfigFile,
} from "@abfc/env";
import type { ModEntry, ProjectConfig, Resolved, UserConfigPatch } from "@abfc/env";
import type { ParsedArgs } from "../args.js";
import { loadContext } from "../context.js";
import type { CliContext, CliDeps } from "../context.js";
import {
  GITIGNORE_LINES,
  SAMPLE_CLASS_TEXT,
  SAMPLE_TEST_TEXT,
  TSCONFIG_TEXT,
  extensionsJsonText,
  projectConfigText,
  tasksJsonText,
} from "../init/templates.js";
import { Output } from "../output.js";
import { doctor } from "./doctor.js";
import { stubs } from "./stubs.js";

type FileAction = "written" | "kept" | "updated";

/** One file of the project (or a backup next to it). `text` null means there is nothing to write. */
interface FileOp {
  rel: string;
  abs: string;
  action: FileAction;
  text: string | null;
}

/** What the mod choice produced (steps 3 to 7 of the design). */
interface Selection {
  mod: ModEntry;
  editorRoot: Resolved<string>;
  modsDir: Resolved<string>;
  profile: Profile;
}

/** What `chooseModInteractively` gets to work with. */
interface Session {
  args: ParsedArgs;
  deps: CliDeps;
  target: string;
  existing: ProjectConfig | null;
  userConfig: Partial<ProjectConfig> | null;
}

const nodeFs = {
  writeFile: (p: string, text: string): void => writeFileSync(p, text, "utf8"),
  mkdir: (p: string): void => void mkdirSync(p, { recursive: true }),
};

const MOD_NAME = /^[A-Za-z0-9_]+$/;
const SAMPLE_DIR = "Samples";
const SAMPLE_BASE = "BP_HelloAbfc";

function noTerminal(why: string): AbfcError {
  return envError(
    1041,
    `no terminal to ask in (${why}).`,
    [],
    "run abfc init in a terminal, or use --mod <name> --yes.",
  );
}

/** ABFC1040: an ancestor folder (not the target) holds abf.config.json. */
function assertNotNested(deps: CliDeps, target: string): void {
  let cur = win32.dirname(target);
  for (;;) {
    if (deps.host.exists(win32.join(cur, PROJECT_CONFIG_FILE))) {
      throw envError(
        1040,
        `${cur} already holds ${PROJECT_CONFIG_FILE}; a project inside another project is not supported.`,
        [{ source: cur, detail: `holds ${PROJECT_CONFIG_FILE}` }],
        "choose a folder outside that project, or run abfc init in it.",
      );
    }
    const parent = win32.dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}

function modList(mods: readonly ModEntry[]): Array<{ source: string; detail: string }> {
  return mods.map((m) => ({
    source: m.name,
    detail: `${m.friendlyName === null ? "" : `"${m.friendlyName}", `}${m.assetCount}${m.assetCountCapped ? "+" : ""} assets`,
  }));
}

/** Steps 5 and 7: the mod from `--mod` (or the existing project) must be in the scan; written with the folder's spelling. */
function selectNonInteractive(s: Session, editorRoot: Resolved<string>, modsDir: Resolved<string>, profile: Profile): Selection {
  const modsPath = modsDir.value as string;
  const mods = scanMods(s.deps.host, modsPath);
  if (mods.length === 0) {
    throw envError(
      1044,
      `no mods found in ${modsPath}.`,
      [{ source: modsPath, detail: "no folder holds <name>\\<name>.uplugin" }],
      "create a mod in the Mod Editor first, or point --mods-dir at the right folder.",
    );
  }
  const wanted = s.args.flags.mod ?? s.existing?.mod.name;
  if (wanted === undefined) throw noTerminal("--yes needs --mod <name> when the folder has no project yet");
  const hit = mods.find((m) => m.name.toLowerCase() === wanted.toLowerCase());
  if (hit === undefined || !MOD_NAME.test(hit.name)) {
    throw envError(
      1042,
      hit === undefined
        ? `mod "${wanted}" not found in ${modsPath}.`
        : `mod folder "${hit.name}" has characters Unreal does not allow in asset paths (A-Z, a-z, 0-9, _).`,
      modList(mods),
      "pick one of the listed mods with --mod <name>, or create the mod in the Mod Editor first.",
    );
  }
  return { mod: hit, editorRoot, modsDir, profile };
}

/** Step 6 (the prompt); implemented with the interactive flow. */
async function chooseModInteractively(s: Session): Promise<Selection> {
  void s;
  throw noTerminal("the interactive prompt is not available");
}

/** True when a `.ts` file exists below `dir`. */
function hasTsFile(host: CliDeps["host"], dir: string, depth = 0): boolean {
  if (depth > 12) return false;
  for (const name of host.readDir(dir)) {
    if (name.toLowerCase().endsWith(".ts")) return true;
    if (hasTsFile(host, win32.join(dir, name), depth + 1)) return true;
  }
  return false;
}

/** Appends the missing lines to an existing .gitignore text (nothing is removed). */
function mergeGitignore(existing: string): string {
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return existing;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const sep = existing === "" || existing.endsWith("\n") ? "" : eol;
  return `${existing}${sep}${missing.join(eol)}${eol}`;
}

/** Sets `mod.name` in the text of an abf.config.json (2-space JSON). */
function withModName(text: string, mod: string): string {
  const root = JSON.parse(text.replace(/^﻿/, "")) as Record<string, unknown>;
  const m = typeof root.mod === "object" && root.mod !== null && !Array.isArray(root.mod) ? (root.mod as Record<string, unknown>) : {};
  m.name = mod;
  root.mod = m;
  return `${JSON.stringify(root, null, 2)}\n`;
}

const relOf = (target: string, abs: string): string => win32.relative(target, abs).replace(/\\/g, "/");

interface Plan {
  ops: FileOp[];
  warnings: Diagnostic[];
  notes: string[];
  userConfig: { path: string | null; keys: string[]; op: FileOp | null; backup: FileOp | null };
}

function buildPlan(s: Session, sel: Selection): Plan {
  const { deps, target, existing, userConfig } = s;
  const host = deps.host;
  const flags = s.args.flags;
  const ops: FileOp[] = [];
  const warnings: Diagnostic[] = [];
  const notes: string[] = [];
  const at = (rel: string): string => win32.join(target, ...rel.split("/"));
  const add = (rel: string, action: FileAction, text: string | null): void => void ops.push({ rel, abs: at(rel), action, text });

  // abf.config.json
  let machineKeys: Record<string, string> = {};
  const cfgAbs = at(PROJECT_CONFIG_FILE);
  if (existing === null) {
    add(PROJECT_CONFIG_FILE, "written", projectConfigText(sel.mod.name, sel.profile.initScriptClasses));
  } else {
    const raw = deps.host.readFile(cfgAbs);
    let text = raw;
    if (existing.schemaVersion < 2) {
      const m = migrateProjectConfigText(raw);
      text = m.text;
      machineKeys = m.machineKeys;
      if (m.droppedModAssets.length > 0) {
        notes.push(`dropped stubs.modAssets entries that name another mod: ${m.droppedModAssets.join(", ")}`);
      }
      const bak = `${PROJECT_CONFIG_FILE}.v1.bak`;
      if (host.exists(at(bak))) add(bak, "kept", null);
      else add(bak, "written", raw);
    }
    if (existing.mod.name.toLowerCase() !== sel.mod.name.toLowerCase()) text = withModName(text, sel.mod.name);
    add(PROJECT_CONFIG_FILE, text === raw ? "kept" : "updated", text === raw ? null : text);
  }
  const sourceRoot = existing?.sourceRoot ?? "src";

  // tsconfig.json: never rewritten
  const tsAbs = at("tsconfig.json");
  if (!host.exists(tsAbs)) {
    add("tsconfig.json", "written", TSCONFIG_TEXT);
  } else {
    add("tsconfig.json", "kept", null);
    const text = host.readFile(tsAbs);
    if (!/"extends"\s*:\s*"[^"]*tsconfig\.paths\.json"/.test(text)) {
      warnings.push(
        envWarning(
          1043,
          'tsconfig.json does not extend "./.abfc/tsconfig.paths.json".',
          [],
          'add "extends": "./.abfc/tsconfig.paths.json" at the top of tsconfig.json.',
        ),
      );
    }
    if (/@abfc\/ts-plugin/.test(text)) {
      warnings.push(
        envWarning(
          1043,
          "tsconfig.json still loads @abfc/ts-plugin, which is retired.",
          [],
          'remove the {"name": "@abfc/ts-plugin"} entry from compilerOptions.plugins in tsconfig.json.',
        ),
      );
    }
  }

  // .gitignore: missing lines are appended
  const giAbs = at(".gitignore");
  if (!host.exists(giAbs)) {
    add(".gitignore", "written", `${GITIGNORE_LINES.join("\n")}\n`);
  } else {
    const raw = host.readFile(giAbs);
    const merged = mergeGitignore(raw);
    add(".gitignore", merged === raw ? "kept" : "updated", merged === raw ? null : merged);
  }

  // .vscode files: only when absent
  const vscode: Array<[string, string]> = [
    [".vscode/tasks.json", tasksJsonText()],
    [".vscode/extensions.json", extensionsJsonText()],
  ];
  for (const [rel, text] of vscode) {
    if (host.exists(at(rel))) add(rel, "kept", null);
    else add(rel, "written", text);
  }

  // Sample: only when the source root holds no .ts file (a kept sample stays listed on a re-run)
  const srcDir = at(sourceRoot.replace(/\\/g, "/"));
  const noTs = !hasTsFile(host, srcDir);
  const sampleFiles: Array<[string, string]> = [
    [`${sourceRoot.replace(/\\/g, "/")}/${SAMPLE_DIR}/${SAMPLE_BASE}.ts`, SAMPLE_CLASS_TEXT],
    [`${sourceRoot.replace(/\\/g, "/")}/${SAMPLE_DIR}/${SAMPLE_BASE}.test.ts`, SAMPLE_TEST_TEXT],
  ];
  for (const [rel, text] of sampleFiles) {
    if (host.exists(at(rel))) add(rel, "kept", null);
    else if (noTs) add(rel, "written", text);
  }

  // User config (design 18.4): a key is written when it is missing, was given as a flag, came from the old project
  // config, or was chosen in the prompt.
  const patch: UserConfigPatch = {};
  const pick = (r: Resolved<string>, migrated: string | undefined, userHas: boolean): string | undefined => {
    if (r.source === "flag" && r.value !== null) return win32.resolve(r.value);
    if (migrated !== undefined) return migrated;
    if (!userHas && r.value !== null) return r.value;
    return undefined;
  };
  const er = pick(sel.editorRoot, machineKeys["editor.root"], userConfig?.editor?.root !== undefined);
  if (er !== undefined) patch.editorRoot = er;
  const md = pick(sel.modsDir, machineKeys.modsDir, userConfig?.modsDir !== undefined);
  if (md !== undefined) patch.modsDir = md;
  const bd = flags.backendDir !== undefined ? win32.resolve(flags.backendDir) : machineKeys["backend.serverDir"];
  if (bd !== undefined) patch.backendDir = bd;
  const py = flags.python !== undefined ? flags.python : machineKeys["backend.python"];
  if (py !== undefined) patch.python = py;
  const moved = Object.keys(machineKeys).filter((k) => k === "editor.root" || k === "modsDir" || k.startsWith("backend."));
  if (moved.length > 0) notes.push(`moved ${moved.join(", ")} from ${PROJECT_CONFIG_FILE} to the user config`);
  const lost = Object.entries(machineKeys).filter(([k]) => !moved.includes(k));
  if (lost.length > 0) {
    notes.push(
      `removed from ${PROJECT_CONFIG_FILE} (set them in the user config by hand if you need them): ${lost.map(([k, v]) => `${k} = ${v}`).join(", ")}`,
    );
  }

  const userPath = userConfigFile(host.env);
  let userOp: FileOp | null = null;
  let backup: FileOp | null = null;
  let keys: string[] = [];
  if (userPath !== null) {
    const existingText = host.exists(userPath) ? host.readFile(userPath) : null;
    const r = updateUserConfigText(existingText, patch, userPath);
    keys = r.changedKeys;
    if (existingText === null) userOp = { rel: userPath, abs: userPath, action: "written", text: r.text };
    else if (r.changedKeys.length === 0) userOp = { rel: userPath, abs: userPath, action: "kept", text: null };
    else {
      userOp = { rel: userPath, abs: userPath, action: "updated", text: r.text };
      backup = { rel: `${userPath}.bak`, abs: `${userPath}.bak`, action: "written", text: existingText };
    }
  }

  return { ops, warnings, notes, userConfig: { path: userPath, keys, op: userOp, backup } };
}

function applyOps(fs: NonNullable<CliDeps["fs"]>, ops: readonly (FileOp | null)[]): void {
  for (const op of ops) {
    if (op === null || op.text === null || op.action === "kept") continue;
    fs.mkdir(win32.dirname(op.abs));
    fs.writeFile(op.abs, op.text);
  }
}

/** A command context for the freshly written project, sharing the init output. */
function subContext(args: ParsedArgs, deps: CliDeps, target: string, command: string, output: Output): CliContext {
  const ctx = loadContext({ ...args, command, positionals: [], flags: { ...args.flags, project: target } }, deps);
  return { ...ctx, output };
}

async function guarded(output: Output, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof AbfcError) {
      output.diag(e.diagnostic);
      return e.exitCode;
    }
    throw e;
  }
}

async function initProject(args: ParsedArgs, deps: CliDeps, target: string, output: Output): Promise<number> {
  const flags = args.flags;
  const host = deps.host;
  const fs = deps.fs ?? nodeFs;

  // 1 and 2: target and mode
  assertNotInModFolder(host, target);
  assertNotNested(deps, target);
  const cfgAbs = win32.join(target, PROJECT_CONFIG_FILE);
  const existing = host.exists(cfgAbs) ? loadProjectConfig(target, host) : null;

  const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!flags.yes && !interactive) throw noTerminal("stdin or stdout is not a terminal");

  // 3 and 4: Mod Editor and mods folder (design 9.1 order, without the project config)
  const userConfig = loadUserConfig(host.env, host);
  const defaultProfile = loadProfile();
  const editorRoot = findEditorRoot(host, defaultProfile, flags.editorRoot, undefined, userConfig?.editor?.root);
  const profile = profileForBuild(editorRoot.appVersion) ?? defaultProfile;
  let documents: Resolved<string> | null = null;
  try {
    documents = findDocuments(host);
  } catch {
    documents = null;
  }
  const modsDir = findModsDir(host, profile, documents, flags.modsDir, undefined, userConfig?.modsDir);

  // 5 to 7: the mod
  const session: Session = { args, deps, target, existing, userConfig };
  const sel = flags.yes ? selectNonInteractive(session, editorRoot, modsDir, profile) : await chooseModInteractively(session);

  // 8 and 9: the plan, then the writes
  const plan = buildPlan(session, sel);
  applyOps(fs, [plan.userConfig.backup, ...plan.ops, plan.userConfig.op]);

  output.info(`abfc init ${target}`);
  output.info(`  mod              ${sel.mod.name}${sel.mod.friendlyName === null ? "" : `  "${sel.mod.friendlyName}"`}`);
  output.info(`  Mod Editor       ${sel.editorRoot.value as string}  [${sel.editorRoot.source}]`);
  output.info(`  mods folder      ${sel.modsDir.value as string}  [${sel.modsDir.source}]`);
  const line = (rel: string, action: FileAction): void => output.info(`  ${action.padEnd(8)} ${rel}`);
  for (const op of plan.ops) line(op.rel, op.action);
  if (plan.userConfig.op !== null) {
    line(`${plan.userConfig.path as string} (user config${plan.userConfig.keys.length > 0 ? `: ${plan.userConfig.keys.join(", ")}` : ""})`, plan.userConfig.op.action);
  }
  for (const n of plan.notes) output.info(`  note: ${n}`);
  for (const w of plan.warnings) output.diag(w);

  // 10 and 11: stubs, then doctor (in process, sharing the output)
  let stubsCode: number | null = null;
  if (!flags.noStubs) {
    output.info("abfc stubs");
    stubsCode = await guarded(output, () => stubs(subContext(args, deps, target, "stubs", output)));
  }
  const doctorCode = await guarded(output, () => doctor(subContext(args, deps, target, "doctor", output)));

  // 12: the JSON result
  output.json({
    project: target,
    mod: sel.mod.name,
    modsDir: sel.modsDir.value,
    editorRoot: sel.editorRoot.value,
    files: plan.ops.map((op) => ({ path: op.rel, action: op.action })),
    userConfig: { path: plan.userConfig.path, keys: plan.userConfig.keys },
    stubs: stubsCode,
    doctor: doctorCode,
  });
  return Math.max(stubsCode ?? 0, doctorCode, output.finish());
}

/** `abfc init [dir] [--mod <name>] [--yes] [--no-stubs] ...`: returns the exit code; never needs an existing project. */
export async function runInit(args: ParsedArgs, deps: CliDeps): Promise<number> {
  const flags = args.flags;
  const base = deps.cwd ?? process.cwd();
  const target = win32.resolve(base, args.positionals[0] ?? flags.project ?? ".");
  const output = new Output({ command: "init", json: flags.json, projectDir: target, stdout: deps.stdout, stderr: deps.stderr });
  try {
    return await initProject(args, deps, target, output);
  } catch (e) {
    if (e instanceof AbfcError) {
      output.diag(e.diagnostic);
      return Math.max(e.exitCode, output.finish());
    }
    throw e;
  }
}
