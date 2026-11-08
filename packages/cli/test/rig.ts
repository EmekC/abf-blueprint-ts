// Shared harness of the CLI end-to-end tests: the fake machine, the project rig and the asset-op helpers.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { loadProfile, realHost, resolveEnvironment } from "@abfc/env";
import type { Host } from "@abfc/env";
import { CACHE_FILE, STUBGEN_VERSION, newLock, writeCatalog, writeLock } from "@abfc/stubgen";
import type { StubCache } from "@abfc/stubgen";
import { main } from "../src/index.js";
import type { CliDeps } from "../src/index.js";
import { FakeBackend } from "./fake-backend.js";
import type { FakeBackendOptions } from "./fake-backend.js";
import { fakeEnvironmentFiles } from "./helpers.js";

export const profile = loadProfile();
// compiled to packages/cli/dist/test/ -> packages/compiler/test/fixtures/project
export const here = fileURLToPath(new URL("./", import.meta.url));
export const fixtureProject = fileURLToPath(new URL("../../../compiler/test/fixtures/project", import.meta.url));

export const key = (p: string): string => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

/** The fake machine for everything outside `roots`; the real file system below them (the project and the fake run folders). */
export function hybridHost(fake: Host, roots: string[]): Host {
  const real = realHost();
  const keys = roots.map(key);
  const isReal = (p: string): boolean => keys.some((r) => key(p) === r || key(p).startsWith(r + "\\"));
  return {
    ...fake,
    exists: (p) => (isReal(p) ? real.exists(p) : fake.exists(p)),
    readFile: (p) => (isReal(p) ? real.readFile(p) : fake.readFile(p)),
    readDir: (p) => (isReal(p) ? real.readDir(p) : fake.readDir(p)),
    stat: (p) => (isReal(p) ? real.stat(p) : fake.stat(p)),
  };
}

export const MATCHER = /^(.*\.ts):(\d+):(\d+): (error|warning) (ABFC\d+): (.*)$/;

/** Every diagnostic line is either `abfc: <severity> <code>: ...` or the problem-matcher form. */
export function assertMatcherLines(text: string): void {
  for (const l of text.split("\n")) {
    if (!/\b(error|warning) ABFC\d+: /.test(l)) continue;
    if (/^abfc: (error|warning) ABFC\d+: /.test(l)) continue;
    assert.match(l, MATCHER, `not in problem-matcher form: ${l}`);
  }
}

export interface Run {
  code: number;
  out: string;
}

export interface Rig {
  dir: string;
  backend: FakeBackend;
  started: { count: number; cold: boolean[] };
  run(argv: string[], extra?: Partial<CliDeps>): Promise<Run>;
  lockFile: string;
}

/** The reflect cache of a finished stub generation (empty data): with it a build reflects only what is missing, never the whole set. */
export function writeRigCache(profileDir: string, editorFingerprint: string): void {
  const cache: StubCache = {
    version: 1,
    generator: STUBGEN_VERSION,
    editorFingerprint,
    // The profile's default classes, as the coverage file says: an incremental run merges its data onto these.
    reflect: {
      engineVersion: null,
      classes: Object.fromEntries(
        profile.initScriptClasses.map((c) => [c, { meta: "/Script/CoreUObject.Class", ancestors: ["/Script/CoreUObject.Object"], castPin: "AsX", properties: [], functions: [] }]),
      ),
      structs: {},
      errors: [],
    },
    filter: { contentVersion: null, rules: [] },
    manual: [],
  };
  writeFileSync(join(profileDir, CACHE_FILE), gzipSync(JSON.stringify(cache)));
}

export async function withRig(o: FakeBackendOptions, fn: (r: Rig) => Promise<void>): Promise<void> {
  // inside the package tree so that `@abfc/runtime` still resolves through the workspace node_modules
  const dir = mkdtempSync(join(here, "e2e-"));
  const backend = new FakeBackend(o);
  try {
    cpSync(fixtureProject, dir, { recursive: true });
    rmSync(join(dir, "src", "Bad.ts"));
    writeFileSync(
      join(dir, "abf.config.json"),
      JSON.stringify({ mod: { name: "TestMod" }, backend: { kind: "bp_apply", minProtocol: 1 } }),
      "utf8",
    );
    const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
    const host = hybridHost(fake.host(), [dir, backend.root]);
    const env = resolveEnvironment(host, { projectDir: dir, flags: {} });
    const lockFile = join(dir, ".abfc", "stubs", profile.id);
    writeLock(
      lockFile,
      newLock({
        profile: profile.id,
        engineVersion: null,
        modEditorVersion: profile.modEditorVersion,
        editorFingerprint: env.fingerprint ?? "",
        filterContentVersion: null,
        classes: [],
        scriptClasses: [],
        modAssets: [],
        auto: { catalogSha256: "test", gameClasses: 0, failed: [], added: [] },
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    // A catalog and coverage that already hold everything the fixture needs, so a build has no stubs to generate (stubsNeedWork is null).
    writeCatalog(lockFile, {
      version: 1,
      editorFingerprint: env.fingerprint ?? "",
      engineVersion: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      game: [],
      scriptClasses: [],
      scriptStructs: [],
      scriptEnums: [],
    });
    const defaults = [...profile.initScriptClasses].sort();
    writeFileSync(join(lockFile, "_coverage.json"), JSON.stringify({ version: 1, reflected: defaults, declared: defaults, errors: [] }), "utf8");
    writeRigCache(lockFile, env.fingerprint ?? "");
    const started = { count: 0, cold: [] as boolean[] };
    const run = async (argv: string[], extra: Partial<CliDeps> = {}): Promise<Run> => {
      const lines: string[] = [];
      const deps: CliDeps = {
        host,
        startBackend: async (_env, o) => {
          started.count++;
          started.cold.push(o?.cold === true);
          return backend;
        },
        now: () => new Date(2026, 0, 2, 3, 4, 5),
        cwd: dir,
        stdout: (l) => lines.push(l),
        stderr: (l) => lines.push(l),
        ...extra,
      };
      const code = await main(argv, deps);
      const out = lines.join("\n");
      assertMatcherLines(out);
      return { code, out };
    };
    await fn({ dir, backend, started, run, lockFile });
  } finally {
    backend.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

export const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

// ---- Asset operations on the stage (A10): rename, move, delete, reparent, recreate ----

export const OPS = { assetOps: true } as const;
export const tally = (cls: string, parent = "Actor", director = false): string =>
  [
    director ? 'import { blueprint, event, director } from "@abfc/runtime";' : 'import { blueprint, event } from "@abfc/runtime";',
    'import type { int } from "@abfc/runtime";',
    `import { ${parent} } from "/Script/FakeEngine";`,
    "",
    ...(director ? ['@director("EntityDirector_Test")'] : []),
    "@blueprint()",
    `export class ${cls} extends ${parent} {`,
    "  Total!: int;",
    "",
    "  @event",
    "  Bump(by: int): void {",
    "    this.Total = by;",
    "  }",
    "}",
    "",
  ].join("\n");
export const TA = "/TestMod/BP_Tally";

/** The stub classes the parent tests extend: Pawn (an Actor) and an engine ActorComponent. */
export function addParentStubs(dir: string): void {
  const file = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
  const text = readFileSync(file, "utf8");
  writeFileSync(
    file,
    text +
      "\n/**\n * @bpPath /Script/FakeEngine.Pawn\n * @bpMeta /Script/CoreUObject.Class\n */\nexport declare class Pawn extends Actor {}\n" +
      "\n/**\n * @bpPath /Script/Engine.ActorComponent\n * @bpMeta /Script/CoreUObject.Class\n */\nexport declare class ActorComponent extends UObject {}\n",
    "utf8",
  );
}

export function tallyOnly(dir: string, src: string): void {
  rmSync(join(dir, "src", "Relay.ts"));
  rmSync(join(dir, "src", "Relay.test.ts"));
  writeFileSync(join(dir, "src", "Tally.ts"), src, "utf8");
}

export function fileExists(file: string): boolean {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
}
