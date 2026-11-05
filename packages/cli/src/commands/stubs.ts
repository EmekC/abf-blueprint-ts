import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import type { Backend, ReflectData } from "@abfc/backend";
import { ownedSets } from "@abfc/compiler";
import { AbfcError } from "@abfc/env";
import {
  emitStubsWithIndex,
  manualFromExport,
  manualReferences,
  missingStructs,
  newLock,
  rulesFromPairs,
  writeLock,
  writeStubs,
  writeTsconfigPaths,
} from "@abfc/stubgen";
import type { ManualAsset } from "@abfc/stubgen";
import type { CliContext } from "../context.js";
import { recordRun } from "../runs.js";
import { ensureStage } from "./stage.js";

/** Folders of the mod's Content that are never stubbed. */
const SKIPPED_FOLDERS = ["_McpTest", "_McpTmp"];

/** Every `*.uasset` below `<modDir>\Content`, as `/<mod>/<path without extension>`. */
function listModAssets(ctx: CliContext, modDir: string): string[] {
  const host = ctx.deps.host;
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of host.readDir(dir)) {
      if (SKIPPED_FOLDERS.includes(name)) continue;
      if (name.toLowerCase().endsWith(".uasset")) {
        out.push(`/${ctx.config.mod.name}/${rel}${name.slice(0, -".uasset".length)}`);
      } else if (!name.includes(".")) {
        walk(win32.join(dir, name), `${rel}${name}/`);
      }
    }
  };
  walk(win32.join(modDir, "Content"), "");
  return out.sort();
}

/** `.d.ts` next to a package entry point, as an absolute path (resolved from this package, never hardcoded). */
function declarationOf(spec: string): string {
  const req = createRequire(import.meta.url);
  return req.resolve(spec).replace(/\.js$/, ".d.ts");
}

function merge(into: ReflectData, add: ReflectData): void {
  into.engineVersion ??= add.engineVersion;
  for (const [k, v] of Object.entries(add.classes)) if (into.classes[k] === undefined) into.classes[k] = v;
  for (const [k, v] of Object.entries(add.structs)) if (into.structs[k] === undefined) into.structs[k] = v;
  into.errors.push(...add.errors);
}

async function reflectAndRead(ctx: CliContext, backend: Backend): Promise<number> {
  const { config, env, output, deps, paths } = ctx;
  const mod = config.mod.name;
  const at = (): string => deps.now().toISOString();
  const clock = (): number => performance.now();

  const info = await backend.info();
  if (!info.capabilities.reflect) {
    throw new AbfcError({
      severity: "error",
      code: "ABFC4011",
      message: `the backend at ${env.backendDir.value ?? "?"} has no "reflect" tool; abfc stubs needs the abfc-p1-backend branch of abf-mod-editor-mcp.`,
      fix: "point ABFC_BACKEND_DIR at a checkout that provides reflect (see docs/backend.md).",
    });
  }
  if (config.stubs.scriptModules !== undefined && config.stubs.scriptModules.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC3010",
      message: "stubs.scriptModules is ignored in Phase 1; list the classes in stubs.scriptClasses instead.",
    });
  }

  // Mod assets first, so their struct references join the reflect closure.
  const modAssetsCfg = config.stubs.modAssets;
  const modDir = env.modDir.value;
  const assetList = modAssetsCfg === "all" ? (modDir === null ? [] : listModAssets(ctx, modDir)) : modAssetsCfg;
  const manual: ManualAsset[] = [];
  const owned = ownedSets(ctx.projectDir);
  const t0 = clock();
  if (assetList.length > 0) {
    await ensureStage(backend, env, config, { resync: ctx.args.flags.resync });
    for (const asset of assetList) {
      try {
        const snap = await backend.read(mod, asset);
        const text = deps.host.readFile(snap.exportPath);
        manual.push(manualFromExport(asset, text, snap.structure, owned[asset] ?? { units: [], variables: [] }));
      } catch (e) {
        if (e instanceof AbfcError && e.diagnostic.code !== "ABFC4002" && e.diagnostic.code !== "ABFC4100") throw e;
        output.diag({
          severity: "warning",
          code: "ABFC4002",
          message: `could not read ${asset} for stubs, skipped: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }
  recordRun(paths.runsFile, { at: at(), step: "stubs.read", seconds: (clock() - t0) / 1000, ok: true, units: manual.length, mode: "cold" });

  // Reflection: the configured classes, then the struct closure (depth 2).
  const t1 = clock();
  const classes = [...config.stubs.classes];
  const first = await backend.reflect({
    mod,
    classes: [...classes, ...config.stubs.scriptClasses],
    structs: [],
    castTargets: classes,
  });
  const data: ReflectData = { engineVersion: null, classes: {}, structs: {}, errors: [] };
  merge(data, first.data);
  const manualRefs = manual.flatMap((m) => manualReferences(m));
  for (let depth = 0; depth < 2; depth++) {
    const need = missingStructs(data, manualRefs);
    if (need.length === 0) break;
    const more = await backend.reflect({ mod, classes: [], structs: need, castTargets: [] });
    merge(data, more.data);
  }
  recordRun(paths.runsFile, {
    at: at(),
    step: "stubs.reflect",
    seconds: (clock() - t1) / 1000,
    ok: true,
    units: Object.keys(data.classes).length,
    mode: "cold",
  });
  for (const msg of data.errors) {
    output.diag({ severity: "warning", code: "ABFC4002", message: `reflect: ${msg}` });
  }
  for (const c of classes) {
    if (data.classes[c] !== undefined && data.classes[c].castPin === null) {
      output.diag({ severity: "warning", code: "ABFC3004", message: `no cast pin could be determined for ${c}; casts to it will be refused.` });
    }
  }

  // Emit and write.
  const t2 = clock();
  const { files, index } = emitStubsWithIndex({
    profile: env.profile,
    reflect: data,
    filter: { rules: rulesFromPairs(first.filter.rules), contentVersion: first.filter.contentVersion },
    manual,
    mod,
    opaque: [],
  });
  const profileDir = win32.join(paths.stubsDir, env.profile.id);
  writeStubs(profileDir, files);
  writeLock(
    profileDir,
    newLock({
      profile: env.profile.id,
      engineVersion: data.engineVersion,
      modEditorVersion: env.profile.modEditorVersion,
      editorFingerprint: env.fingerprint ?? "",
      filterContentVersion: first.filter.contentVersion,
      classes,
      scriptClasses: [...config.stubs.scriptClasses],
      modAssets: manual.map((m) => m.asset),
      createdAt: deps.now().toISOString(),
    }),
  );
  writeFileSync(win32.join(profileDir, "_index.json"), JSON.stringify(index, null, 2) + "\n", "utf8");
  mkdirSync(paths.abfcDir, { recursive: true });
  writeTsconfigPaths(paths.abfcDir, env.profile.id, mod, declarationOf("@abfc/runtime"), declarationOf("@abfc/testkit"));
  recordRun(paths.runsFile, { at: at(), step: "stubs.emit", seconds: (clock() - t2) / 1000, ok: true, units: files.size, mode: "cold" });

  output.info(`stubs written to ${profileDir}`);
  output.info(`  ${files.size} file(s), ${index.members} member(s), ${index.deprecated.length} blocked, ${index.overridden.length} overridden, ${index.opaque.length} opaque`);
  output.info(`  hand-made assets: ${manual.length}`);
  output.json({ dir: profileDir, files: index.files, members: index.members, opaque: index.opaque, modAssets: manual.map((m) => m.asset) });
  return 0;
}

/** `abfc stubs`: reflects the configured classes and mod assets through the backend and writes `.abfc/stubs/<profile>/`. */
export async function stubs(ctx: CliContext): Promise<number> {
  const backend = await ctx.deps.startBackend(ctx.env);
  try {
    return await reflectAndRead(ctx, backend);
  } finally {
    await backend.close();
  }
}
