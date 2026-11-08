import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { loadProfile } from "@abfc/env";
import type { ProjectConfig } from "@abfc/env";
import { catalogFromBackend, newLock, writeCatalog, writeLock } from "@abfc/stubgen";
import type { AutoStubs, Catalog } from "@abfc/stubgen";
import type { StubImport } from "@abfc/compiler";
import type { CliContext } from "../src/context.js";
import { resolveStubRequest, stubsNeedWork } from "../src/stubsauto.js";
import type { StubRequestInput } from "../src/stubsauto.js";

const FAKE = "/Game/Fake/BP_Fake.BP_Fake_C";
const OTHER = "/Game/Fake/BP_Other.BP_Other_C";
const HUD = "/Game/Fake/Sub/WBP_Hud.WBP_Hud_C";
const THING = "/Script/FakeEngine.Thing";
const OTHER_NATIVE = "/Script/FakeEngine.Other";
const VEC = "/Script/FakeEngine.FakeVec";
const ENUM = "/Script/FakeEngine.EFake";
const DEFAULT = "/Script/FakeEngine.Actor";

const catalog: Catalog = catalogFromBackend(
  {
    version: 1,
    engineVersion: "5.4.4-fake",
    game: [
      { path: FAKE, kind: "Blueprint", parent: THING, interface: false },
      { path: OTHER, kind: "Blueprint", parent: THING, interface: false },
      { path: HUD, kind: "Widget", parent: null, interface: false },
    ],
    scriptClasses: [
      { path: THING, parent: null },
      { path: OTHER_NATIVE, parent: THING },
      { path: DEFAULT, parent: null },
    ],
    scriptStructs: [VEC],
    scriptEnums: [ENUM],
  },
  "fp-1",
  "2026-01-02T00:00:00.000Z",
);

const base = (o: Partial<StubRequestInput> = {}): StubRequestInput => ({
  catalog,
  reflected: new Set(),
  declared: new Set(),
  defaults: [DEFAULT],
  configClasses: [],
  configScriptClasses: [],
  widgetClasses: [],
  sourceImports: [],
  added: [],
  adds: [],
  failed: [],
  full: false,
  ...o,
});

const imp = (specifier: string, names: string[]): StubImport => ({ specifier, names, file: "src/X.ts" });

test("a full run wants every catalog game class plus the defaults", () => {
  const r = resolveStubRequest(base({ full: true }));
  assert.deepEqual(r.want.classes, [FAKE, OTHER, HUD, DEFAULT]);
  assert.deepEqual(r.missing.classes, r.want.classes);
  assert.deepEqual(r.want.structs, []);
  assert.deepEqual(r.userClasses, []);
});

test("without a full run only the defaults, the config and the widget classes are wanted; reflected ones are not missing", () => {
  const r = resolveStubRequest(
    base({ configClasses: [FAKE], configScriptClasses: [THING], widgetClasses: ["/Script/UMG.TextBlock"], reflected: new Set([DEFAULT, THING]) }),
  );
  assert.deepEqual(r.want.classes, [FAKE, DEFAULT, THING, "/Script/UMG.TextBlock"]);
  assert.deepEqual(r.missing.classes, [FAKE, "/Script/UMG.TextBlock"]);
  assert.deepEqual(r.userClasses, [FAKE]);
});

test("failed classes are skipped, unless --add names them", () => {
  const failed = resolveStubRequest(base({ full: true, failed: [OTHER] }));
  assert.ok(!failed.want.classes.includes(OTHER));
  const retried = resolveStubRequest(base({ full: true, failed: [OTHER], adds: [OTHER] }));
  assert.ok(retried.want.classes.includes(OTHER));
  assert.deepEqual(retried.added, [OTHER]);
  assert.deepEqual(retried.userClasses, [OTHER]);
});

test("source imports of /Script names are placed by kind; a declared enum is not requested again", () => {
  const sourceImports = [imp("/Script/FakeEngine", ["Other", "FakeVec", "EFake", "Missing"])];
  const fresh = resolveStubRequest(base({ sourceImports }));
  assert.deepEqual(fresh.want.classes, [DEFAULT, OTHER_NATIVE]);
  assert.deepEqual(fresh.want.structs, [VEC]);
  assert.deepEqual(fresh.opaqueEnums, [ENUM]);
  assert.deepEqual(fresh.missing.structs, [VEC]);
  const declared = resolveStubRequest(base({ sourceImports, reflected: new Set([DEFAULT, OTHER_NATIVE, VEC]), declared: new Set([ENUM]) }));
  assert.deepEqual(declared.opaqueEnums, []);
  assert.deepEqual(declared.missing, { classes: [], structs: [] });
});

test("a /Game import with names resolves them; without names it wants every class of the module", () => {
  const named = resolveStubRequest(base({ sourceImports: [imp("/Game/Fake/BP_Fake", ["BP_Fake_C"])] }));
  assert.deepEqual(named.want.classes, [FAKE, DEFAULT]);
  assert.deepEqual(named.userClasses, [FAKE]);
  const all = resolveStubRequest(base({ sourceImports: [imp("/Game/Fake/Sub/WBP_Hud", [])] }));
  assert.deepEqual(all.want.classes, [HUD, DEFAULT]);
  const unknown = resolveStubRequest(base({ sourceImports: [imp("/Game/Fake/Nope", ["X"]), imp("/Script/FakeEngine", [])] }));
  assert.deepEqual(unknown.want.classes, [DEFAULT]);
});

test("--add resolves a path, a TS name, a module and an enum; an unknown argument is notFound", () => {
  const r = resolveStubRequest(base({ adds: [OTHER_NATIVE, "/Script/FakeEngine.FakeVec", "/Game/Fake/Sub/WBP_Hud", ENUM, "/Script/FakeEngine.Nope", "nonsense"] }));
  assert.deepEqual(r.want.classes, [HUD, DEFAULT, OTHER_NATIVE]);
  assert.deepEqual(r.want.structs, [VEC]);
  assert.deepEqual(r.opaqueEnums, [ENUM]);
  assert.deepEqual(r.added, [HUD, ENUM, VEC, OTHER_NATIVE]);
  assert.deepEqual(r.notFound, ["/Script/FakeEngine.Nope", "nonsense"]);
});

test("earlier additions are kept; one the catalog no longer knows is dropped", () => {
  const r = resolveStubRequest(base({ added: [OTHER_NATIVE, "/Game/Gone/BP_Gone.BP_Gone_C"] }));
  assert.deepEqual(r.want.classes, [DEFAULT, OTHER_NATIVE]);
  assert.deepEqual(r.added, [OTHER_NATIVE]);
});

test("without a catalog: defaults, config lists, widget classes and the added paths as given", () => {
  const r = resolveStubRequest(
    base({ catalog: null, configClasses: [FAKE], configScriptClasses: [THING], adds: [OTHER_NATIVE], sourceImports: [imp("/Script/FakeEngine", ["Other"])], full: true }),
  );
  assert.deepEqual(r.want.classes, [FAKE, DEFAULT, OTHER_NATIVE, THING]);
  assert.deepEqual(r.want.structs, []);
  assert.deepEqual(r.notFound, []);
  assert.deepEqual(r.added, [OTHER_NATIVE]);
});

// ---- stubsNeedWork ----

const FP = "fingerprint-1";
const AUTO: AutoStubs = { catalogSha256: "x", gameClasses: 3, failed: [], added: [] };

interface Project {
  ctx: CliContext;
  profileDir: string;
  dir: string;
}

function project(tmp: string, o: { fingerprint?: string | null; sources?: Record<string, string>; classes?: string[] } = {}): Project {
  const profile = loadProfile();
  const stubsDir = win32.join(tmp, ".abfc", "stubs");
  const profileDir = win32.join(stubsDir, profile.id);
  mkdirSync(join(tmp, "src"), { recursive: true });
  for (const [name, text] of Object.entries(o.sources ?? {})) writeFileSync(join(tmp, "src", name), text, "utf8");
  const config = { sourceRoot: "src", stubs: { classes: o.classes ?? [], scriptClasses: [], widgetMembers: {}, modAssets: [] } } as unknown as ProjectConfig;
  const ctx = {
    projectDir: tmp,
    config,
    env: { profile, fingerprint: o.fingerprint === undefined ? FP : o.fingerprint },
    paths: { stubsDir },
  } as unknown as CliContext;
  return { ctx, profileDir, dir: tmp };
}

function writeLockFor(p: Project, o: { fingerprint?: string; auto?: AutoStubs | null } = {}): void {
  const lock = newLock({
    profile: p.ctx.env.profile.id,
    engineVersion: null,
    modEditorVersion: p.ctx.env.profile.modEditorVersion,
    editorFingerprint: o.fingerprint ?? FP,
    filterContentVersion: null,
    classes: [],
    scriptClasses: [],
    modAssets: [],
    ...(o.auto === null ? {} : { auto: o.auto ?? AUTO }),
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  writeLock(p.profileDir, lock);
}

function writeCoverage(p: Project, reflected: string[], declared = reflected): void {
  writeFileSync(join(p.profileDir, "_coverage.json"), JSON.stringify({ version: 1, reflected, declared, errors: [] }), "utf8");
}

const withTmp = (fn: (tmp: string) => void): void => {
  const tmp = mkdtempSync(join(tmpdir(), "abfc-stubsauto-"));
  try {
    fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

test("stubsNeedWork: each reason in order, then null", () => {
  withTmp((tmp) => {
    const p = project(tmp, { sources: { "A.ts": `import { Other, EFake } from "/Script/FakeEngine";\nexport const x = [Other, EFake];\n` } });
    const defaults = p.ctx.env.profile.initScriptClasses;
    assert.equal(stubsNeedWork(p.ctx), "no stubs yet");

    writeLockFor(p, { fingerprint: "old" });
    assert.equal(stubsNeedWork(p.ctx), "the Mod Editor build changed");

    writeLockFor(p, { auto: null });
    assert.equal(stubsNeedWork(p.ctx), "the stubs do not cover every game class yet");

    writeLockFor(p);
    assert.equal(stubsNeedWork(p.ctx), "no class catalog for this editor build");

    writeCatalog(p.profileDir, { ...catalog, editorFingerprint: "other" });
    assert.equal(stubsNeedWork(p.ctx), "no class catalog for this editor build", "a catalog of another editor build does not count");

    writeCatalog(p.profileDir, { ...catalog, editorFingerprint: FP });
    assert.equal(stubsNeedWork(p.ctx), "the stub coverage file is missing");

    writeCoverage(p, [...defaults]);
    assert.equal(stubsNeedWork(p.ctx), "missing stubs for Other, EFake");

    writeCoverage(p, [...defaults, OTHER_NATIVE], [...defaults, OTHER_NATIVE, ENUM]);
    assert.equal(stubsNeedWork(p.ctx), null);
  });
});

test("stubsNeedWork: a new /Game import and a config class are missing; a failed class is not; many names are cut at five", () => {
  withTmp((tmp) => {
    const p = project(tmp, { sources: { "A.ts": `import { BP_Fake_C } from "/Game/Fake/BP_Fake";\nexport const x = BP_Fake_C;\n` }, classes: [OTHER] });
    const defaults = p.ctx.env.profile.initScriptClasses;
    writeCatalog(p.profileDir, { ...catalog, editorFingerprint: FP });
    writeLockFor(p);
    writeCoverage(p, [...defaults]);
    assert.equal(stubsNeedWork(p.ctx), "missing stubs for BP_Fake_C, BP_Other_C");

    writeLockFor(p, { auto: { ...AUTO, failed: [FAKE, OTHER] } });
    assert.equal(stubsNeedWork(p.ctx), null, "failed classes wait for --add, --refresh or a new editor build");

    writeLockFor(p, { auto: { ...AUTO, added: [THING, OTHER_NATIVE, VEC, ENUM, DEFAULT + "2", HUD, FAKE] } });
    assert.match(stubsNeedWork(p.ctx) ?? "", /^missing stubs for .+ and \d+ more$/);
  });
});

test("stubsNeedWork: no fingerprint (an editor that cannot be fingerprinted) skips the fingerprint comparisons", () => {
  withTmp((tmp) => {
    const p = project(tmp, { fingerprint: null });
    writeLockFor(p, { fingerprint: "anything" });
    writeCatalog(p.profileDir, { ...catalog, editorFingerprint: "something else" });
    writeCoverage(p, [...p.ctx.env.profile.initScriptClasses]);
    assert.equal(stubsNeedWork(p.ctx), null);
  });
});
