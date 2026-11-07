import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "@abfc/ir";
import { SourceFileCache, checkProject, loadProgram, writeManifest } from "../src/index.js";
import type { Manifest } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures and packages/env/profiles
const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

const same = (a: string, b: string): boolean => resolve(a).replaceAll("\\", "/").toLowerCase() === resolve(b).replaceAll("\\", "/").toLowerCase();

/** Relay.ts with an extra event that divides two ints. */
function relayWithDivision(text: string): string {
  const withImport = text.replace('import { blueprint, event, cast, isValid } from "@abfc/runtime";', 'import { blueprint, event, cast, isValid } from "@abfc/runtime";\nimport type { int } from "@abfc/runtime";');
  const end = withImport.lastIndexOf("}");
  return `${withImport.slice(0, end)}\n  @event\n  Divide(a: int, b: int): void {\n    const q = a / b;\n  }\n}\n`;
}

test("an overlaid file is what the program sees: checkProject reports an integer division that exists only in memory", () => {
  const dir = fixture("project");
  const relay = join(dir, "src", "Relay.ts");
  const onDisk = readFileSync(relay, "utf8");
  const baseline = checkProject(loadProgram(dir), config, profile);
  assert.equal(baseline.diagnostics.filter((d) => d.code === "ABFC2010" && d.span?.file === "src/Relay.ts").length, 0);

  const overlaid = relayWithDivision(onDisk);
  const loaded = loadProgram(dir, undefined, { overlay: (f) => (same(f, relay) ? overlaid : undefined) });
  const res = checkProject(loaded, config, profile);
  const hits = res.diagnostics.filter((d) => d.code === "ABFC2010" && d.span?.file === "src/Relay.ts");
  assert.equal(hits.length, 1, JSON.stringify(res.diagnostics.filter((d) => d.span?.file === "src/Relay.ts")));
  assert.equal(hits[0]!.span?.line, overlaid.split("\n").findIndex((l) => l.includes("a / b")) + 1);
  assert.equal(readFileSync(relay, "utf8"), onDisk, "the disk file is untouched");
});

test("a source-file cache hands back the same SourceFile for unchanged text and a new one for the overlaid file", () => {
  const dir = fixture("project");
  const relay = join(dir, "src", "Relay.ts");
  const cache = new SourceFileCache();
  const first = loadProgram(dir, undefined, { cache });
  assert.ok(cache.size > 0);
  const overlaid = relayWithDivision(readFileSync(relay, "utf8"));
  const second = loadProgram(dir, first.program, { cache, overlay: (f) => (same(f, relay) ? overlaid : undefined) });

  const stub = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
  const a = first.program.getSourceFile(stub);
  const b = second.program.getSourceFile(stub);
  assert.ok(a !== undefined && b !== undefined);
  assert.equal(b, a, "an unchanged stub is not parsed again");
  const r1 = first.program.getSourceFile(relay);
  const r2 = second.program.getSourceFile(relay);
  assert.ok(r1 !== undefined && r2 !== undefined);
  assert.notEqual(r2, r1);
  assert.equal(r2.text, overlaid);
  assert.equal(r1.text, readFileSync(relay, "utf8"));

  const n = cache.size;
  cache.retain(first.program);
  assert.ok(cache.size <= n);
  cache.retain(loadProgram(fixture("phase2"), undefined, { cache: new SourceFileCache() }).program);
  assert.ok(cache.size < n, "entries of files that are not in the program are dropped");
});

const asset = "/Fake/Mod/BP_Host";
const stub = `// generated
export interface BP_Host_Manual {
  /**
   * @bpPath ${asset}.BP_Host_C:StopDirector
   * @bpHandMade
   */
  StopDirector(): void;
  /**
   * @bpPath ${asset}.BP_Host_C:Refresh
   * @bpHandMade
   */
  Refresh(): void;
}
`;
const source = `import type { BP_Host_Manual } from "/Fake/Mod/BP_Host";
export interface Host extends BP_Host_Manual {}
export class Host {
  StopDirectorNew(): void {}
  Caller(): void {
    this.StopDirector();
    this.Refresh();
  }
}
`;

function manifest(units: string[]): Manifest {
  return {
    asset,
    compiler: "0.1.0",
    profile: "p",
    units: units.map((id) => ({ id, graph: "EventGraph", irHash: "sha256:x", assetHash: null, nodes: [], nodeIds: {}, tag: null, stageSyncedAt: null, adopt: null })),
    variables: [],
  };
}

test("the _Manual stub filter still applies when a source-file cache is used", () => {
  const dir = mkdtempSync(join(tmpdir(), "abfc-wscache-"));
  try {
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text, "utf8");
    };
    put("tsconfig.json", JSON.stringify({
      compilerOptions: { target: "es2023", lib: ["es2023"], module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true, skipLibCheck: true, types: [], paths: { "/Fake/*": ["./.abfc/stubs/*.js"] } },
      include: ["src"],
    }));
    put(".abfc/stubs/Mod/BP_Host.d.ts", stub);
    put("src/Host.ts", source);
    writeManifest(dir, manifest(["event:StopDirector", "event:StopDirectorNew"]));
    const cache = new SourceFileCache();
    const first = loadProgram(dir, undefined, { cache });
    assert.equal(first.diagnostics.length, 1, JSON.stringify(first.diagnostics));
    assert.match(first.diagnostics[0]!.message, /TS2551.*'StopDirector'/);
    assert.equal(first.diagnostics[0]!.span?.line, 6);
    const second = loadProgram(dir, first.program, { cache, overlay: () => undefined });
    assert.deepEqual(second.diagnostics.map((d) => d.message), first.diagnostics.map((d) => d.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
