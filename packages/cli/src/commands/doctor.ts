import { win32 } from "node:path";
import { AbfcError, checkHeadlessDir, envWarning, machineKeysInProject } from "@abfc/env";
import type { Resolved } from "@abfc/env";
import { MIN_BACKEND_VERSION, RECOMMENDED_BACKEND_VERSION } from "@abfc/backend";
import type { Backend } from "@abfc/backend";
import type { BackendInfo, Diagnostic } from "@abfc/ir";
import type { ParsedArgs } from "../args.js";
import { installOf } from "../context.js";
import type { CliContext, CliDeps } from "../context.js";
import { Output } from "../output.js";
import { backendInfoDiagnostics, recommendedBackendDiagnostics } from "./backend-version.js";

function show(label: string, r: Resolved<string>, extra = ""): string {
  const value = r.value === null ? "(not found)" : r.value;
  const source = r.value === null ? "" : `  [${r.source}]`;
  return `  ${label.padEnd(16)} ${value}${extra}${source}`;
}

const norm = (p: string): string => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

function asDiagnostic(e: unknown, what: string): Diagnostic {
  if (e instanceof AbfcError) return e.diagnostic;
  return {
    severity: "error",
    code: "ABFC4002",
    message: `${what}: ${(e as Error).message}`,
    fix: "run abfc doctor --verbose, or check the backend folder and Python.",
  };
}

/** `abfc doctor`: every discovered setting with its source, then the backend and its capabilities. Returns the exit code. */
export async function doctor(ctx: CliContext): Promise<number> {
  const { env, output, config, deps } = ctx;

  output.info("abfc doctor");
  output.info(`  project          ${ctx.projectDir}`);
  output.info(`  mod              ${config.mod.name}`);
  output.info(`  profile          ${env.profile.id} (editor build tag ${env.profile.buildTag})`);
  output.info(`  node             ${deps.host.nodeVersion}`);
  const install = installOf(deps);
  const info0 = install.info();
  output.info(
    info0.kind === "exe" ? `  abfc             exe ${info0.abfcVersion ?? "?"}, runtime ${info0.runtimeDir ?? "?"}` : "  abfc             source install",
  );
  const installJson = { kind: info0.kind, abfcVersion: info0.abfcVersion, runtimeDir: info0.runtimeDir };
  let runtimeCheck: { files: number; repaired: boolean } | null = null;
  if (ctx.args.flags.deep) {
    const r = install.verify(true);
    if (r === null) {
      output.info("  runtime check    none (source install)");
    } else {
      runtimeCheck = { files: r.files, repaired: r.repaired };
      output.info(`  runtime check    ${r.files} files verified by sha256${r.repaired ? " (repaired)" : ""}`);
    }
  }
  const extra = ctx.args.flags.deep ? { install: installJson, runtimeCheck } : { install: installJson };
  output.info("settings (winner and source: flag > env > abf.config.json > user config > auto):");
  output.info(show("editor root", env.editorRoot, env.appVersion ? `  (build ${env.appVersion})` : ""));
  output.info(show("documents", env.documents));
  output.info(show("mods folder", env.modsDir));
  output.info(show("mod folder", env.modDir));
  output.info(show("python", env.python, env.python.version ? `  (Python ${env.python.version})` : ""));
  output.info(show("backend folder", env.backendDir));
  output.info(show("headless folder", env.headlessDir));

  // Environment diagnostics in check order: Node first, then project config, then the rest as discovered.
  const nodeDiags = env.diagnostics.filter((d) => d.code === "ABFC1030");
  for (const d of nodeDiags) output.diag(d);

  const machineKeys = machineKeysInProject(config);
  if (machineKeys.length > 0) {
    output.diag(
      envWarning(
        1021,
        `abf.config.json holds machine-specific keys: ${machineKeys.join(", ")}.`,
        [],
        "move them to %APPDATA%\\abfc\\config.json so the project config can be committed.",
      ),
    );
  }

  for (const d of env.diagnostics) if (d.code !== "ABFC1030") output.diag(d);

  // The exe ships its own backend and Python; an older source-install setting can still win over them (design 9.1).
  if (info0.kind === "exe" && info0.runtimeDir !== null) {
    const rt = norm(info0.runtimeDir);
    const outside: string[] = [];
    for (const [label, r] of [["python", env.python], ["backend folder", env.backendDir]] as const) {
      if (r.value === null || r.source === "auto") continue;
      const v = norm(r.value);
      if (v !== rt && !v.startsWith(rt + "\\")) outside.push(`${label} ${r.value} [${r.source}]`);
    }
    if (outside.length > 0) {
      output.diag(
        envWarning(
          1053,
          `abfc.exe uses a ${outside.join(" and a ")} outside its own runtime folder ${info0.runtimeDir}.`,
          [],
          "remove the old backend / python setting (ABFC_BACKEND_DIR, ABFC_PYTHON, \"backendDir\" / \"python\" in the user config or abf.config.json) to use the bundled ones, or keep it on purpose.",
        ),
      );
    }
  }

  if (env.editorRoot.value !== null && env.appVersion === null) {
    output.diag(
      envWarning(
        3002,
        "cannot confirm the editor build: no Epic manifest AppVersionString was found for this install.",
        [{ source: "profile", detail: `expecting build tag ${env.profile.buildTag}` }],
        "ignore this if the editor was installed by hand; otherwise reinstall it from the Epic Games Launcher.",
      ),
    );
  }

  // Backend
  const python = env.python.value;
  const backendDir = env.backendDir.value;
  const headlessDir = env.headlessDir.value;
  const headlessBlocked = env.diagnostics.some((d) => d.code === "ABFC1012");
  let skip: string | null = null;
  if (python === null) skip = "Python not found";
  else if (backendDir === null) skip = "backend folder not set";
  else if (headlessDir === null) skip = "headless folder unknown";
  else if (headlessBlocked) skip = "the headless folder is not usable (see ABFC1012)";
  if (skip !== null) {
    output.info(`backend: not checked (${skip})`);
    output.json({ settings: settingsJson(ctx), backend: null, ...extra });
    return output.exitCode();
  }

  let backend: Backend | null = null;
  let info: BackendInfo | null = null;
  try {
    backend = await deps.startBackend(env);
    info = await backend.info();
  } catch (e) {
    output.diag(asDiagnostic(e, "could not query the backend"));
  } finally {
    if (backend !== null) {
      try {
        await backend.close();
      } catch {
        // the backend is gone already
      }
    }
  }

  if (info !== null) {
    checkInfo(ctx, info);
    printInfo(ctx, info);
  }
  output.json({ settings: settingsJson(ctx), backend: info, ...extra });
  return output.exitCode();
}

/** `abfc doctor --clean-runtimes`: deletes the extracted runtime folders of other versions (and only those). Needs no project. Returns the exit code. */
export function cleanRuntimesCommand(args: ParsedArgs, deps: CliDeps): number {
  const output = new Output({ command: "doctor", json: args.flags.json, projectDir: args.flags.project, stdout: deps.stdout, stderr: deps.stderr });
  const r = installOf(deps).clean();
  for (const p of r.removed) output.info(`removed ${p}`);
  for (const p of r.failed) {
    output.diag(envWarning(1051, `in use, not removed: ${p}`, [], "close other abfc processes (language server, builds) and run the command again."));
  }
  for (const p of r.skipped) output.info(`left alone (not an abfc runtime folder): ${p}`);
  if (r.kept !== null) output.info(`kept ${r.kept}`);
  if (r.removed.length === 0 && r.failed.length === 0) output.info("nothing to remove");
  output.json({ removed: r.removed, failed: r.failed, skipped: r.skipped, kept: r.kept });
  return output.finish();
}

function checkInfo(ctx: CliContext, info: BackendInfo): void {
  const { output, config, env } = ctx;
  for (const d of backendInfoDiagnostics(info, config.backend.minProtocol, env.backendDir.value ?? "?")) output.diag(d);
  for (const d of recommendedBackendDiagnostics(info, env.backendDir.value ?? "?")) output.diag(d);
  if (info.headlessDir !== null) {
    const d = checkHeadlessDir(info.headlessDir);
    if (d !== null) output.diag(d);
    if (env.headlessDir.value !== null && norm(info.headlessDir) !== norm(env.headlessDir.value)) {
      output.diag(
        envWarning(
          1013,
          `the backend uses the headless folder ${info.headlessDir}, abfc resolved ${env.headlessDir.value}.`,
          [],
          "set ABF_HEADLESS_DIR (or abfc's --headless-dir) so both agree.",
        ),
      );
    }
  }
  if (info.documentsDir !== null && env.documents.value !== null && norm(info.documentsDir) !== norm(env.documents.value)) {
    output.diag(
      envWarning(
        1002,
        `the backend reports the Documents folder ${info.documentsDir}, abfc resolved ${env.documents.value}.`,
        [],
        "set modsDir / modDir explicitly (flags, env or config) to the folder you mean.",
      ),
    );
  }
}

function printInfo(ctx: CliContext, info: BackendInfo): void {
  const { output } = ctx;
  const c = info.capabilities;
  const yn = (b: boolean): string => (b ? "yes" : "no");
  output.info(
    `backend: server ${info.serverVersion} (minimum ${MIN_BACKEND_VERSION}), protocol ${info.protocol === null ? "(no backend_info)" : info.protocol}`,
  );
  if (info.engineVersion !== null) output.info(`  engine: ${info.engineVersion}`);
  output.info(
    `  wildcard pin types: ${c.pinTypes ? "native" : "fallback (two-phase raw graph, +10-20 s per build)"}`,
  );
  if (c.castObjectPin) output.info("  cast Object: typed by backend");
  const bc = c.backendContainerTypes;
  output.info(
    `  containers: backend ${bc ? `array: ${bc.array}, map: ${bc.map}, set: ${bc.set}` : "not reported"}; ` +
      `abfc array: ${c.containerTypes.array}, map: ${c.containerTypes.map}, set: ${c.containerTypes.set}, struct: ${c.createKinds.includes("UserDefinedStruct")}`,
  );
  output.info(
    `  reflect: ${yn(c.reflect)}, compile node refs: ${yn(c.compileErrorNodeRefs)}, game test: ${yn(c.gameTest)}, audit: ${yn(c.audit)}`,
  );
  output.info(`  warm session: ${yn(c.warmSession)}, stage audit: ${yn(c.stageAudit)}, class-manager rows: ${yn(c.classManagerRows)}`);
  output.info(
    `  backend capabilities: asset ops: ${c.assetOps.length > 0 ? c.assetOps.join("/") : "no"}, publish deletions: ${yn(c.publishDeletes)}, ` +
      `gameplay tags: ${yn(c.gameplayTags)}, reflect defaults: ${yn(c.reflectDefaults)}, class-manager row tag: ${yn(c.classManagerRowTag)} ` +
      `(recommended server ${RECOMMENDED_BACKEND_VERSION})`,
  );
  output.info(`  extensions: ${info.extensions.length > 0 ? info.extensions.join(", ") : "(none)"}`);
  if (info.headlessDir !== null) output.info(`  backend headless folder: ${info.headlessDir}`);
  if (info.headlessDirHasSpace) output.info("  backend headless folder contains a space");
}

function settingsJson(ctx: CliContext): Record<string, { value: string | null; source: string }> {
  const e = ctx.env;
  const pick = (r: Resolved<string>): { value: string | null; source: string } => ({ value: r.value, source: r.source });
  return {
    editorRoot: pick(e.editorRoot),
    documents: pick(e.documents),
    modsDir: pick(e.modsDir),
    modDir: pick(e.modDir),
    python: pick(e.python),
    backendDir: pick(e.backendDir),
    headlessDir: pick(e.headlessDir),
  };
}
