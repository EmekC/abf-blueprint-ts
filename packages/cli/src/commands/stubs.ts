import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { win32 } from "node:path";
import type { Backend, ReflectData } from "@abfc/backend";
import { libraryEntriesOf, ownedSets, sourceStubImports } from "@abfc/compiler";
import { AbfcError, runtimeLayout } from "@abfc/env";
import {
  COVERAGE_FILE,
  STUBGEN_VERSION,
  catalogFromBackend,
  catalogLookup,
  completionNamesOf,
  coverageOf,
  emitStubsWithIndex,
  manualFromExport,
  manualReferences,
  missingStructs,
  newLock,
  readCatalog,
  readCoverage,
  readGameTags,
  readLock,
  readStubCache,
  sortedWidgetMembers,
  rulesFromPairs,
  writeFileAtomic,
  writeCatalog,
  writeGameTags,
  writeLock,
  writeStubSet,
  writeTsconfigPaths,
} from "@abfc/stubgen";
import type { Catalog, ManualAsset, StubCache } from "@abfc/stubgen";
import type { CliContext } from "../context.js";
import { reflectAll } from "../reflectchunks.js";
import { recordRun } from "../runs.js";
import { backendIdOf, resolveStubRequest, shortName, stubsNeedWork } from "../stubsauto.js";
import type { StubMode } from "../stubsauto.js";
import { refreshTagsFile } from "../tags.js";
import { BackendSession, Recorder, pruneManifestsToStage, since } from "./common.js";
import { ensureStage } from "./stage.js";

/** Folders of the mod's Content that are never stubbed. */
const SKIPPED_FOLDERS = ["_McpTest", "_McpTmp"];

/** The backend's refusal to read an asset of another class (`<asset> is not a Blueprint (<Class>)`, `<asset> is a <Class>, not a Blueprint`). */
const NOT_A_BLUEPRINT = /not a Blueprint/i;

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

/** What one `abfc stubs` run reflects and writes (decided by {@link generateStubs}). */
interface StubRun {
  mode: StubMode;
  /** Every game class of the catalog is reflected (no valid cache). */
  full: boolean;
  /** The cache of an earlier run: what it holds is not reflected again. */
  seed: StubCache | null;
  /** Read the mod's own assets (explicit runs and runs without a cache); otherwise they come from the seed. */
  readModAssets: boolean;
  classes: string[];
  structs: string[];
  /** The /Game entries of `classes`. */
  castTargets: string[];
  /** Every enum to declare even when no member references it (imported, added, or declared by an earlier run). */
  opaqueEnums: string[];
  /** Classes a missing cast pin is reported for. */
  userClasses: string[];
  catalog: { catalog: Catalog; sha256: string } | null;
  /** Classes an earlier run could not reflect and this run skipped. */
  failed: string[];
  added: string[];
  notFound: string[];
}

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** How many `reflect:` messages of the backend are printed one by one. */
const REFLECT_MESSAGES_SHOWN = 20;

async function reflectAndRead(ctx: CliContext, backend: Backend, run: StubRun): Promise<number> {
  const { config, env, output, deps, paths } = ctx;
  const mod = config.mod.name;
  const at = (): string => deps.now().toISOString();
  const clock = (): number => performance.now();

  const info = await backend.info();
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
  if (!run.readModAssets) {
    manual.push(...run.seed!.manual);
  } else if (assetList.length > 0) {
    for (const asset of assetList) {
      try {
        const snap = await backend.read(mod, asset);
        const text = deps.host.readFile(snap.exportPath);
        manual.push(manualFromExport(asset, text, snap.structure, owned[asset] ?? { units: [], variables: [] }));
      } catch (e) {
        if (e instanceof AbfcError && e.diagnostic.code !== "ABFC4002" && e.diagnostic.code !== "ABFC4100") throw e;
        // The mod also holds assets that are not Blueprints (mod config, class-manager rows, structs, metadata): the backend says so, and they have no stub to make.
        if (e instanceof AbfcError && e.diagnostic.code === "ABFC4002" && NOT_A_BLUEPRINT.test(e.diagnostic.message)) continue;
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
  const profileDir = win32.join(paths.stubsDir, env.profile.id);
  const first =
    run.classes.length + run.structs.length > 0
      ? await reflectAll(
          backend,
          {
            mod,
            classes: run.classes,
            structs: run.structs,
            castTargets: run.castTargets,
            ...(info.capabilities.gameplayTags ? { gameplayTags: true } : {}),
          },
          (l) => output.info(l),
        )
      : null;
  // Nothing to reflect: the game's tags and the filter of the last run stay.
  const filter = first !== null ? first.result.filter : (run.seed?.filter ?? { contentVersion: null, rules: [] });
  const gameTags = first !== null ? (info.capabilities.gameplayTags ? (first.result.data.gameplayTags?.tags ?? []) : null) : readGameTags(profileDir);
  if (first !== null && gameTags === null) {
    output.diag({
      severity: "warning",
      code: "ABFC3012",
      message: "the backend cannot list the game's gameplay tags; .abfc/tags.d.ts holds only the mod's own tags.",
      fix: "update abf-mod-editor-mcp to 2.6.0 or newer, then run abfc stubs again.",
    });
  }
  const data: ReflectData = { engineVersion: null, classes: {}, structs: {}, errors: [] };
  if (first !== null) merge(data, first.result.data);
  // The seed's old messages stay with the run that produced them: data.errors holds this run's messages only.
  if (run.seed !== null) merge(data, { ...run.seed.reflect, errors: [] });
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
  for (const msg of data.errors.slice(0, REFLECT_MESSAGES_SHOWN)) {
    output.diag({ severity: "warning", code: "ABFC4002", message: `reflect: ${msg}` });
  }
  if (data.errors.length > REFLECT_MESSAGES_SHOWN) {
    output.diag({
      severity: "warning",
      code: "ABFC4002",
      message: `… and ${data.errors.length - REFLECT_MESSAGES_SHOWN} more reflect messages (see _coverage.json)`,
    });
  }
  for (const c of run.userClasses) {
    if (data.classes[c] !== undefined && data.classes[c].castPin === null) {
      output.diag({ severity: "warning", code: "ABFC3004", message: `no cast pin could be determined for ${c}; casts to it will be refused.` });
    }
  }
  // A requested class or struct the reflect result does not hold (or holds only as a cast target) is left out and not retried until --add, --refresh or a new editor build.
  const reflectedWithMembers = (c: string): boolean => (data.classes[c] !== undefined && data.classes[c].castOnly !== true) || data.structs[c] !== undefined;
  const failedNow = [...run.classes, ...run.structs].filter((c) => !reflectedWithMembers(c));
  if (failedNow.length > 0) {
    output.diag({
      severity: "warning",
      code: "ABFC3023",
      message: `${failedNow.length} class(es) could not be reflected and are left out of the stubs: ${failedNow.slice(0, 10).map(shortName).join(", ")}${failedNow.length > 10 ? ", ..." : ""}`,
      fix: "abfc stubs --add <path> retries one; abfc stubs --refresh retries all.",
    });
  }

  for (const [cls, members] of Object.entries(config.stubs.widgetMembers)) {
    for (const [member, widget] of Object.entries(members)) {
      if (data.classes[widget] === undefined) {
        output.diag({
          severity: "warning",
          code: "ABFC3011",
          message: `stubs.widgetMembers: ${cls} ${member} is a ${widget}, which is not in the stubs; it is typed UObject.`,
          fix: `"${widget}" is requested automatically; check that it is a class of this editor build, then run "abfc stubs --add ${widget}" to retry it.`,
        });
      }
    }
  }

  // Emit and write.
  const t2 = clock();
  const { files, index } = emitStubsWithIndex({
    profile: env.profile,
    reflect: data,
    filter: { rules: rulesFromPairs(filter.rules), contentVersion: filter.contentVersion },
    manual,
    widgetMembers: config.stubs.widgetMembers,
    mod,
    opaque: [],
    opaqueEnums: run.opaqueEnums,
  });
  const failedFinal = sortedUnique([...run.failed, ...failedNow].filter((c) => !reflectedWithMembers(c)));
  const lock = newLock({
    profile: env.profile.id,
    engineVersion: data.engineVersion,
    modEditorVersion: env.profile.modEditorVersion,
    editorFingerprint: env.fingerprint ?? "",
    filterContentVersion: filter.contentVersion,
    classes: [...config.stubs.classes],
    scriptClasses: [...config.stubs.scriptClasses],
    modAssets: manual.map((m) => m.asset),
    widgetMembers: sortedWidgetMembers(config.stubs.widgetMembers),
    auto:
      run.catalog !== null
        ? { catalogSha256: run.catalog.sha256, gameClasses: run.catalog.catalog.game.length, failed: failedFinal, added: run.added }
        : // A backend without the catalog tool: builds do not start it again to look for the tool until the editor or the backend changes.
          { catalogSha256: "", gameClasses: 0, failed: failedFinal, added: run.added, noCatalog: backendIdOf(env) },
    createdAt: deps.now().toISOString(),
  });
  writeStubSet(profileDir, {
    files,
    index,
    lock,
    coverage: coverageOf(data, index.opaque, data.errors),
    cache: {
      version: 1,
      generator: STUBGEN_VERSION,
      editorFingerprint: env.fingerprint ?? "",
      reflect: data,
      filter: { contentVersion: filter.contentVersion, rules: filter.rules },
      manual,
    },
    library: { version: 1, entries: libraryEntriesOf(files) },
    names: run.catalog !== null ? completionNamesOf(run.catalog.catalog) : null,
    clearRetired: run.readModAssets,
  });
  if (first !== null && gameTags !== null) writeGameTags(profileDir, gameTags);
  mkdirSync(paths.abfcDir, { recursive: true });
  const layout = runtimeLayout();
  writeTsconfigPaths(
    paths.abfcDir,
    env.profile.id,
    mod,
    layout?.runtimeDts ?? declarationOf("@abfc/runtime"),
    layout?.testkitDts ?? declarationOf("@abfc/testkit"),
    layout?.irDts,
  );
  // The stage's own ini tags replace the old file's tags: a tag removed from the stage and the mod leaves tags.d.ts.
  const stageNow = await backend.stageStatus(mod).catch(() => null);
  refreshTagsFile(ctx, [], { stagingPath: stageNow?.stagingPath ?? null });
  recordRun(paths.runsFile, { at: at(), step: "stubs.emit", seconds: (clock() - t2) / 1000, ok: true, units: files.size, mode: "cold" });

  output.info(`stubs written to ${profileDir}`);
  output.info(`  ${files.size} file(s), ${index.members} member(s), ${index.deprecated.length} blocked, ${index.overridden.length} overridden, ${index.opaque.length} opaque`);
  output.info(`  hand-made assets: ${manual.length}`);
  output.json({
    dir: profileDir,
    files: index.files,
    members: index.members,
    opaque: index.opaque,
    modAssets: manual.map((m) => m.asset),
    full: run.full,
    reflected: run.classes.length,
    catalog: run.catalog === null ? null : { game: run.catalog.catalog.game.length, scriptClasses: run.catalog.catalog.scriptClasses.length },
    added: run.added,
    failed: failedFinal,
    notFound: run.notFound,
  });
  return 0;
}

/**
 * Decides what the stubs of this project still need (catalog, cache, source imports, `--add`), reflects it and writes
 * `.abfc/stubs/<profile>/`. `explicit` is `abfc stubs`, `add` is `abfc stubs --add`, `build` is the generation at the start of a build.
 */
export async function generateStubs(ctx: CliContext, backend: Backend, mode: StubMode): Promise<number> {
  const { config, env, output, deps, paths, args } = ctx;
  const flags = args.flags;
  const mod = config.mod.name;
  const profileDir = win32.join(paths.stubsDir, env.profile.id);
  const fingerprint = env.fingerprint ?? "";
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
  const { resynced } = await ensureStage(backend, env, config, { resync: mode === "explicit" ? flags.resync : false, warn: (d) => output.diag(d) });
  if (resynced) await pruneManifestsToStage(ctx, backend, mod);

  // The class catalog of this editor build: the file when it is current, else from the backend.
  let catalog: { catalog: Catalog; sha256: string } | null = flags.refresh ? null : readCatalog(profileDir);
  if (catalog !== null && catalog.catalog.editorFingerprint !== fingerprint) catalog = null;
  if (catalog === null) {
    if (info.capabilities.catalog) {
      const tc = clock();
      const res = await backend.catalog(mod);
      const c = catalogFromBackend(res.data, fingerprint, at());
      catalog = { catalog: c, sha256: writeCatalog(profileDir, c) };
      const seconds = (clock() - tc) / 1000;
      output.info(
        `catalog: ${c.game.length} game classes, ${c.scriptClasses.length} engine classes, ${c.scriptStructs.length} structs, ${c.scriptEnums.length} enums (${seconds.toFixed(1)} s)`,
      );
      recordRun(paths.runsFile, { at: at(), step: "stubs.catalog", seconds, ok: true, units: c.game.length, mode: "cold" });
    } else if (mode !== "build") {
      output.diag({
        severity: "warning",
        code: "ABFC3021",
        message: 'the backend has no "catalog" tool: only the classes in stubs.classes and stubs.scriptClasses (and the profile defaults) get stubs.',
        fix: "update abf-mod-editor-mcp to 2.6.0 or newer.",
      });
    }
  }

  // The cache of the last run: valid for this editor build and generator (a backend without a catalog always reflects everything it is asked for).
  const cache = flags.refresh || catalog === null ? null : readStubCache(profileDir);
  const seed = cache !== null && cache.editorFingerprint === fingerprint && cache.generator === STUBGEN_VERSION ? cache : null;
  const full = catalog !== null && seed === null;
  const storedCoverage = seed === null ? null : readCoverage(profileDir);
  const coverage = seed === null ? null : (storedCoverage ?? coverageOf(seed.reflect, [], []));
  const oldLock = readLock(profileDir);
  const failed = seed === null ? [] : (oldLock?.auto?.failed ?? []);
  const req = resolveStubRequest({
    catalog: catalog?.catalog ?? null,
    reflected: new Set(coverage?.reflected ?? []),
    declared: new Set(coverage?.declared ?? []),
    defaults: env.profile.initScriptClasses,
    configClasses: config.stubs.classes,
    configScriptClasses: config.stubs.scriptClasses,
    widgetClasses: Object.values(config.stubs.widgetMembers).flatMap((m) => Object.values(m)),
    sourceImports: sourceStubImports(ctx.projectDir, config.sourceRoot),
    added: oldLock?.auto?.added ?? [],
    adds: flags.add,
    failed,
    full,
  });
  for (const arg of req.notFound) {
    output.diag({
      severity: "warning",
      code: "ABFC3022",
      message: `${arg} is not a class, struct or enum of this editor build; nothing generated`,
      fix: "check the path; run abfc stubs --refresh after a game update.",
    });
  }
  const classes = mode === "explicit" || full ? req.want.classes : req.missing.classes;
  const structs = mode === "explicit" || full ? req.want.structs : req.missing.structs;
  // Enums an earlier run declared stay declared even when no member references them.
  const lookup = catalog === null ? null : catalogLookup(catalog.catalog);
  const keptEnums = (coverage?.declared ?? []).filter((p) => lookup?.kindOf(p) === "enum");

  if (mode !== "explicit" && seed !== null && classes.length + structs.length === 0 && req.opaqueEnums.length === 0) {
    // A missing or corrupt coverage file would make every build start the backend again: rewrite it from the cache.
    if (storedCoverage === null && coverage !== null) writeFileAtomic(win32.join(profileDir, COVERAGE_FILE), JSON.stringify(coverage, null, 2) + "\n");
    output.info("stubs are up to date");
    output.json({
      dir: profileDir,
      upToDate: true,
      full: false,
      reflected: 0,
      catalog: catalog === null ? null : { game: catalog.catalog.game.length, scriptClasses: catalog.catalog.scriptClasses.length },
      added: req.added,
      failed,
      notFound: req.notFound,
    });
    return 0;
  }
  if (full) {
    output.info(
      `stubs: generating stubs for ${classes.length} classes (${classes.filter((c) => c.startsWith("/Game/")).length} game classes) and the types they use; this runs once per Mod Editor build and takes about 3-4 minutes`,
    );
  }
  const tg = clock();
  const code = await reflectAndRead(ctx, backend, {
    mode,
    full,
    seed,
    readModAssets: mode === "explicit" || seed === null,
    classes,
    structs,
    castTargets: classes.filter((c) => c.startsWith("/Game/")),
    opaqueEnums: sortedUnique([...req.opaqueEnums, ...keptEnums]),
    userClasses: req.userClasses,
    catalog,
    failed,
    added: req.added,
    notFound: req.notFound,
  });
  if (full) output.info(`stubs: done in ${((clock() - tg) / 1000).toFixed(1)} s`);
  return code;
}

/** `abfc stubs`: reflects the game's classes and mod assets through the backend and writes `.abfc/stubs/<profile>/`. */
export async function stubs(ctx: CliContext): Promise<number> {
  const backend = await ctx.deps.startBackend(ctx.env);
  try {
    return await generateStubs(ctx, backend, ctx.args.flags.add.length > 0 ? "add" : "explicit");
  } finally {
    await backend.close();
  }
}

/**
 * Start of `abfc build`, `test` and `publish`: generates the stubs the project needs when the offline check says so (first build, a new
 * Mod Editor build, a new import of an engine or game name). A backend that cannot do it, or a failure, is a warning ABFC3020: the build
 * continues with the stubs there are, and the lock check that follows still stops it when they are unusable.
 */
export async function ensureStubsForBuild(ctx: CliContext, session: BackendSession, rec: Recorder): Promise<void> {
  const reason = stubsNeedWork(ctx);
  if (reason === null) return;
  const t0 = performance.now();
  const warn = (e: unknown): void =>
    ctx.output.diag({
      severity: "warning",
      code: "ABFC3020",
      message: `could not generate stubs (${reason}): ${e instanceof Error ? e.message : String(e)}; the build continues with the existing stubs`,
      fix: 'run "abfc stubs" once the Mod Editor backend works.',
    });
  let opened: Awaited<ReturnType<BackendSession["open"]>>;
  try {
    opened = await session.open();
  } catch (e) {
    warn(e);
    return;
  }
  if (!opened.info.capabilities.reflect || !opened.info.capabilities.catalog) {
    // Remember it in the lock: later builds stay quiet (and do not start the backend for this) until the editor build or the backend changes.
    const lock = readLock(win32.join(ctx.paths.stubsDir, ctx.env.profile.id));
    if (lock !== null && (ctx.env.fingerprint === null || lock.editorFingerprint === ctx.env.fingerprint)) {
      writeLock(win32.join(ctx.paths.stubsDir, ctx.env.profile.id), {
        ...lock,
        auto: { catalogSha256: "", gameClasses: 0, failed: lock.auto?.failed ?? [], added: lock.auto?.added ?? [], noCatalog: backendIdOf(ctx.env) },
      });
      ctx.output.diag({
        severity: "warning",
        code: "ABFC3021",
        message: 'the backend has no "catalog" tool: stubs for engine and game classes are generated only for the classes in stubs.classes and stubs.scriptClasses.',
        fix: "update abf-mod-editor-mcp to 2.6.0 or newer, then run abfc stubs (this is reported once).",
      });
    }
    return;
  }
  ctx.output.info(`stubs: ${reason}; generating them`);
  let ok = false;
  try {
    await generateStubs(ctx, opened.backend, "build");
    ok = true;
  } catch (e) {
    warn(e);
  } finally {
    rec.record("build.stubs", since(t0), ok);
  }
}
