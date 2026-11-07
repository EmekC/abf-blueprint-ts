import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { getAsset, getRawAsset, isSea } from "node:sea";
import { cleanRuntimes, ensureRuntime, runtimeFolderName, type RuntimeManifest, type RuntimeSource } from "./runtime.js";

/**
 * Where abfc finds its own data files: the extracted runtime folder in abfc.exe (design 18.8), nothing in a source install.
 * This module must not import discover.ts (discover.ts imports it).
 */

export interface RuntimeLayout {
  root: string;
  abfcVersion: string;
  profilesDir: string;
  descriptionsJson: string;
  runtimeDts: string;
  testkitDts: string;
  irDts: string;
  tsLibDir: string;
  schemaJson: string;
  backendDir: string;
  pythonExe: string;
}

export function layoutAt(root: string, abfcVersion: string): RuntimeLayout {
  const j = (...p: string[]): string => win32.join(root, ...p);
  return {
    root,
    abfcVersion,
    profilesDir: j("profiles"),
    descriptionsJson: j("data", "descriptions.json"),
    runtimeDts: j("types", "runtime", "index.d.ts"),
    testkitDts: j("types", "testkit", "index.d.ts"),
    irDts: j("types", "ir", "index.d.ts"),
    tsLibDir: j("tslib"),
    schemaJson: j("schema", "abf.config.schema.json"),
    backendDir: j("backend"),
    pythonExe: j("python", "python.exe"),
  };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  const v = key === undefined ? undefined : env[key];
  return v !== undefined && v !== "" ? v : undefined;
}

/** `ABFC_RUNTIME_DIR` (abfc only), else `%LOCALAPPDATA%\abfc\runtime`. */
export function runtimeRoot(env: NodeJS.ProcessEnv): string {
  const override = envValue(env, "ABFC_RUNTIME_DIR");
  if (override !== undefined) return override;
  const local = envValue(env, "LOCALAPPDATA");
  if (local !== undefined) return win32.join(local, "abfc", "runtime");
  return win32.join(homedir(), "AppData", "Local", "abfc", "runtime");
}

let exeMemo: boolean | undefined;

/** True inside the Node single executable application. */
export function isExe(): boolean {
  if (exeMemo === undefined) {
    try {
      exeMemo = isSea();
    } catch {
      exeMemo = false;
    }
  }
  return exeMemo;
}

let manifestMemo: RuntimeManifest | undefined;

export function seaRuntimeSource(): RuntimeSource {
  return {
    manifest: () => {
      manifestMemo ??= JSON.parse(getAsset("runtime.sha256.json", "utf8")) as RuntimeManifest;
      return manifestMemo;
    },
    zip: () => Buffer.from(getRawAsset("runtime.zip")),
  };
}

let layoutMemo: RuntimeLayout | undefined;

/** The extracted runtime's paths in abfc.exe (extracting or repairing it on first use); null in a source install. */
export function runtimeLayout(): RuntimeLayout | null {
  if (!isExe()) return null;
  if (layoutMemo === undefined) {
    const source = seaRuntimeSource();
    const r = ensureRuntime(source, runtimeRoot(process.env));
    layoutMemo = layoutAt(r.dir, source.manifest().abfcVersion);
  }
  return layoutMemo;
}

export interface InstallInfo {
  kind: "exe" | "source";
  abfcVersion: string | null;
  runtimeDir: string | null;
  runtimeRoot: string;
}

/** Describes the install without extracting anything. */
export function installInfo(): InstallInfo {
  const root = runtimeRoot(process.env);
  if (!isExe()) return { kind: "source", abfcVersion: null, runtimeDir: null, runtimeRoot: root };
  const m = seaRuntimeSource().manifest();
  return { kind: "exe", abfcVersion: m.abfcVersion, runtimeDir: win32.join(root, runtimeFolderName(m)), runtimeRoot: root };
}

/** Quick (or, with `deep`, sha256) check of the extracted runtime, repairing it when damaged; null in a source install. */
export function verifyBundledRuntime(deep: boolean): { dir: string; extracted: boolean; repaired: boolean; files: number } | null {
  if (!isExe()) return null;
  const source = seaRuntimeSource();
  const r = ensureRuntime(source, runtimeRoot(process.env), { deep });
  return { ...r, files: Object.keys(source.manifest().files).length };
}

/** Deletes every runtime folder except the running exe's own (a source install keeps none). */
export function cleanBundledRuntimes(): { removed: string[]; failed: string[]; kept: string | null } {
  const root = runtimeRoot(process.env);
  if (!isExe()) return { ...cleanRuntimes(root, null), kept: null };
  const keepName = runtimeFolderName(seaRuntimeSource().manifest());
  const kept = win32.join(root, keepName);
  return { ...cleanRuntimes(root, keepName), kept: existsSync(kept) ? kept : null };
}
