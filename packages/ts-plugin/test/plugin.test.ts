// CommonJS test: ES modules (the compiler, the service) are only reached through `await import(...)`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import plugin = require("../src/index");

// compiled to packages/ts-plugin/dist/test/; temp projects sit inside the package tree so that `@abfc/runtime` resolves.
const here = __dirname;
const fixtureRoot = join(here, "..", "..", "..", "compiler", "test", "fixtures");

const fwd = (p: string): string => p.replaceAll("\\", "/");

/** A copy of a compiler fixture with an `abf.config.json`; `edit` may add or remove files. */
function copyFixture(name: string, edit?: (dir: string) => void): string {
  const dir = mkdtempSync(join(here, "plugin-"));
  cpSync(join(fixtureRoot, name), dir, { recursive: true });
  writeFileSync(join(dir, "abf.config.json"), JSON.stringify({ mod: { name: "TestMod" } }), "utf8");
  edit?.(dir);
  return dir;
}

interface Made {
  ls: ts.LanguageService;
  host: ts.LanguageServiceHost;
  files: string[];
}

/** A language service over a project on disk, like tsserver would run it. */
function createLs(projectDir: string): Made {
  const parsed = ts.getParsedCommandLineOfConfigFile(join(projectDir, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
  assert.ok(parsed);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => parsed.options,
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (f) => (existsSync(f) ? String(statSync(f).mtimeMs) : "0"),
    getScriptSnapshot: (f) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8")) : undefined),
    getCurrentDirectory: () => projectDir,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return { ls: ts.createLanguageService(host, ts.createDocumentRegistry()), host, files: parsed.fileNames };
}

/** Runs the plugin on a language service; returns the proxy and the log lines. */
async function withPlugin(made: Made, projectDir: string, modules: { typescript: typeof ts } = { typescript: ts }): Promise<{ ls: ts.LanguageService; log: string[] }> {
  const log: string[] = [];
  const created = plugin(modules).create({
    languageService: made.ls,
    languageServiceHost: made.host,
    project: { getCurrentDirectory: () => projectDir, projectService: { logger: { info: (s: string) => void log.push(s) } } },
    config: {},
  });
  await plugin.whenReady();
  return { ls: created, log };
}

const abfcOnly = (ds: readonly ts.Diagnostic[]): ts.Diagnostic[] => ds.filter((d) => d.source === "abfc");
const keyOf = (sf: ts.SourceFile, start: number, code: number | string): string => {
  const lc = sf.getLineAndCharacterOfPosition(start);
  return `${code}@${lc.line + 1}:${lc.character + 1}`;
};

async function compilerParts(): Promise<{
  compiler: typeof import("@abfc/compiler");
  profile: import("@abfc/ir").Profile;
}> {
  const compiler = await import("@abfc/compiler");
  const env = await import("@abfc/env");
  return { compiler, profile: env.loadProfile() };
}

for (const name of ["project", "phase2", "phase3", "phase4"]) {
  test(`plugin diagnostics equal checkProject on fixture ${name}`, async () => {
    const dir = copyFixture(name);
    try {
      const { compiler, profile } = await compilerParts();
      const loaded = compiler.loadProgram(dir);
      const expected = compiler.checkProject(loaded, { mod: "TestMod" }, profile).diagnostics;
      const made = createLs(dir);
      const { ls } = await withPlugin(made, dir);
      const program = ls.getProgram();
      assert.ok(program);
      let compared = 0;
      for (const sf of [...loaded.files.classes, ...loaded.files.tests]) {
        const rel = fwd(relative(dir, sf.fileName));
        const want = expected
          .filter((d) => d.span?.file === rel)
          .map((d) => `${Number(d.code.slice(4))}@${d.span?.line}:${d.span?.col}`)
          .sort();
        const lsFile = program.getSourceFile(sf.fileName);
        assert.ok(lsFile, `${rel} is in the plugin's program`);
        const got = abfcOnly(ls.getSemanticDiagnostics(sf.fileName))
          .map((d) => keyOf(lsFile, d.start ?? 0, d.code))
          .sort();
        assert.deepEqual(got, want, `diagnostics of ${rel}`);
        compared += want.length;
      }
      if (name === "project") assert.ok(compared > 0, "the project fixture has subset errors to compare");
      // plugin diagnostics carry the ABFC code in the message
      for (const sf of loaded.files.classes) {
        for (const d of abfcOnly(ls.getSemanticDiagnostics(sf.fileName))) {
          assert.match(String(d.messageText), new RegExp(`^ABFC${d.code}: `));
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("hover inside cast(...) shows the Blueprint node", async () => {
  const dir = copyFixture("project", (d) => rmSync(join(d, "src", "Bad.ts")));
  try {
    const made = createLs(dir);
    const { ls, log } = await withPlugin(made, dir);
    const file = join(dir, "src", "Relay.ts").replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    const at = text.indexOf("cast(player?.Target");
    assert.ok(at >= 0);
    const info = ls.getQuickInfoAtPosition(file, at + 1);
    assert.ok(info, `quick info (log: ${log.join(" | ")})`);
    const docs = ts.displayPartsToString(info.documentation);
    assert.match(docs, /Blueprint: .*Cast To /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const idivSource = `import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";
import type { BP_Counter_Manual } from "/TestMod/Relay/BP_Counter";

export interface BP_Counter extends BP_Counter_Manual {}

@blueprint({ path: "/TestMod/Relay/BP_Counter" })
export class BP_Counter extends Actor {
  @event
  Go(): void {
    this.Count = this.Count / 2;
  }
}
`;

test("quick fix for ABFC2010 rewrites the division to idiv", async () => {
  const dir = copyFixture("phase2", (d) => {
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(d, "src", f));
    writeFileSync(join(d, "src", "Div.ts"), idivSource, "utf8");
  });
  try {
    const made = createLs(dir);
    const { ls, log } = await withPlugin(made, dir);
    const file = join(dir, "src", "Div.ts").replaceAll("\\", "/");
    const diags = abfcOnly(ls.getSemanticDiagnostics(file));
    assert.equal(diags.length, 1, `one diagnostic (log: ${log.join(" | ")})`);
    const d = diags[0]!;
    assert.equal(d.code, 2010);
    assert.match(String(d.messageText), /^ABFC2010: /);
    const start = d.start ?? 0;
    const end = start + (d.length ?? 0);
    assert.ok(ls.getSupportedCodeFixes().includes("2010"));
    const fixes = ls.getCodeFixesAtPosition(file, start, end, [2010], {}, {});
    const fix = fixes.find((f) => f.fixName === "abfcIdiv");
    assert.ok(fix);
    assert.equal(fix.description, "Use idiv(a, b) (Blueprint Divide_IntInt)");
    let fixed = idivSource;
    const changes = fix.changes[0]!.textChanges.slice().sort((a, b) => b.span.start - a.span.start);
    for (const c of changes) fixed = fixed.slice(0, c.span.start) + c.newText + fixed.slice(c.span.start + c.span.length);
    assert.match(fixed, /import \{ blueprint, event, idiv \} from "@abfc\/runtime";/);
    assert.match(fixed, /this\.Count = idiv\(this\.Count, 2\);/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quick fix for 'possibly undefined' adds ?.", async () => {
  const src = `export function f(a: { b: number } | undefined): number | undefined {\n  return a.b;\n}\n`;
  const dir = copyFixture("phase2", (d) => {
    for (const f of ["Phase2Bad.ts", "Counter.ts", "Director.ts"]) rmSync(join(d, "src", f));
    writeFileSync(join(d, "src", "Opt.ts"), src, "utf8");
  });
  try {
    const made = createLs(dir);
    const { ls } = await withPlugin(made, dir);
    const file = join(dir, "src", "Opt.ts").replaceAll("\\", "/");
    const tsDiag = ls.getSemanticDiagnostics(file).find((d) => d.code === 18048);
    assert.ok(tsDiag, "TS18048 on `a`");
    const start = tsDiag.start ?? 0;
    const end = start + (tsDiag.length ?? 0);
    const fix = ls.getCodeFixesAtPosition(file, start, end, [18048], {}, {}).find((f) => f.fixName === "abfcOptionalChain");
    assert.ok(fix);
    assert.equal(fix.description, "Use ?. (lowers to IsValid + Branch)");
    const c = fix.changes[0]!.textChanges[0]!;
    assert.equal(src.slice(0, c.span.start) + c.newText + src.slice(c.span.start + c.span.length), src.replace("a.b", "a?.b"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another TypeScript version leaves the language service unchanged", async () => {
  const dir = copyFixture("project");
  try {
    const made = createLs(dir);
    const snapshot = made.host.getScriptSnapshot;
    const version = made.host.getScriptVersion;
    const fake = { ...ts, version: "0.0.0" } as typeof ts;
    const { ls, log } = await withPlugin(made, dir, { typescript: fake });
    assert.ok(log.some((l) => l.startsWith("[abfc] disabled:") && l.includes("0.0.0")), `logged: ${log.join(" | ")}`);
    assert.equal(made.host.getScriptSnapshot, snapshot);
    assert.equal(made.host.getScriptVersion, version);
    const file = fwd(join(dir, "src", "Bad.ts"));
    assert.deepEqual(abfcOnly(ls.getSemanticDiagnostics(file)), []);
    assert.deepEqual(ls.getSupportedCodeFixes(), made.ls.getSupportedCodeFixes());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A host that behaves like tsserver's: the program is only rebuilt when `getProjectVersion()` changes, which `markAsDirty` bumps. */
function createVersionedLs(projectDir: string): { made: Made; dirtied: () => number; markAsDirty: () => void } {
  const made = createLs(projectDir);
  let version = 0;
  made.host.getProjectVersion = () => String(version);
  return {
    made,
    dirtied: () => version,
    markAsDirty: () => {
      version++;
    },
  };
}

const retiredHideAll = JSON.stringify({ "/TestMod/Relay/BP_Relay": ["event:HideAll"] });

test("stub filtering applies to a program built before the service module loaded, and follows later manifest changes", async () => {
  const dir = copyFixture("project", (d) => rmSync(join(d, "src", "Bad.ts")));
  try {
    const stubProfile = join(dir, ".abfc", "stubs", "test");
    const retired = join(stubProfile, "retired.json");
    const { made, dirtied, markAsDirty } = createVersionedLs(dir);
    const relay = fwd(join(dir, "src", "Relay.ts"));
    const missingHideAll = (ls: ts.LanguageService): boolean => ls.getSemanticDiagnostics(relay).some((d) => d.code === 2339 && String(ts.flattenDiagnosticMessageText(d.messageText, "\n")).includes("HideAll"));

    // nothing is retired yet; the first program is built before the plugin's service exists, from unfiltered stubs
    writeFileSync(retired, "{}", "utf8");
    const log: string[] = [];
    const created = plugin({ typescript: ts }).create({
      languageService: made.ls,
      languageServiceHost: made.host,
      project: { getCurrentDirectory: () => dir, projectService: { logger: { info: (s: string) => void log.push(s) } }, markAsDirty },
      config: {},
    });
    assert.ok(made.ls.getProgram());
    assert.equal(missingHideAll(made.ls), false, "unfiltered stubs declare HideAll");

    // abfc build retired HideAll while the editor was open: a program of the same project version is stale until the service marks the project dirty
    writeFileSync(retired, retiredHideAll, "utf8");
    await plugin.whenReady();
    assert.ok(dirtied() >= 1, `the service marked the project dirty (log: ${log.join(" | ")})`);
    assert.equal(missingHideAll(created), true, "the filter applies to the first program that is asked for after the service started");

    // a manifest change after that is noticed on the next request, once the one-second token cache has expired
    writeFileSync(retired, "{}", "utf8");
    const before = dirtied();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(missingHideAll(created), false, "the stale filter is dropped");
    assert.ok(dirtied() > before, "the project was marked dirty again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
