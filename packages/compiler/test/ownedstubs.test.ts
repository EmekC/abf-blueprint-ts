import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadProgram, readRetired, writeManifest, writeRetired } from "../src/index.js";
import type { Manifest } from "../src/index.js";
import { filterOwnedManual } from "../src/frontend/manualfilter.js";

const asset = "/Fake/Mod/BP_Host";
const stub = `// generated
export interface BP_Host_Manual {
  /**
   * @bpPath ${asset}.BP_Host_C:Count
   * @bpType int
   * @bpHandMade
   */
  Count: number;
  /**
   * @bpPath ${asset}.BP_Host_C:HideAll
   * @bpHandMade
   */
  HideAll(): void;
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
    this.HideAll();
    this.Refresh();
  }
}
`;
const CALL_LINE = 6;

function manifest(units: string[]): Manifest {
  return {
    asset,
    compiler: "0.1.0",
    profile: "p",
    units: units.map((id) => ({ id, graph: "EventGraph", irHash: "sha256:x", assetHash: null, nodes: [], nodeIds: {}, tag: null, stageSyncedAt: null, adopt: null })),
    variables: [],
  };
}

function withProject(units: string[] | null, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "abfc-owned-"));
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
    if (units !== null) writeManifest(dir, manifest(units));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an owned event is hidden from the _Manual stub: calling it after the TS class dropped it is a TS error at the call", () => {
  withProject(["event:StopDirector", "event:StopDirectorNew"], (dir) => {
    const { diagnostics } = loadProgram(dir);
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    assert.equal(diagnostics[0]!.code, "ABFC2000");
    assert.match(diagnostics[0]!.message, /TS2551.*'StopDirector'/);
    assert.equal(diagnostics[0]!.span?.file, "src/Host.ts");
    assert.equal(diagnostics[0]!.span?.line, CALL_LINE);
  });
});

test("members abfc does not own keep their stub: hand-made functions and events type-check", () => {
  withProject(["event:StopDirector"], (dir) => {
    const { diagnostics } = loadProgram(dir);
    assert.deepEqual(diagnostics.filter((d) => d.span?.line !== CALL_LINE), []);
  });
});

test("without a manifest nothing is hidden", () => {
  withProject(null, (dir) => {
    assert.deepEqual(loadProgram(dir).diagnostics, []);
  });
});

test("filterOwnedManual removes owned functions, events and variables only, and returns the text itself when nothing matches", () => {
  const owned = { [asset]: { units: ["function:HideAll", "event:Refresh"], variables: ["Count"] } };
  const out = filterOwnedManual("BP_Host.d.ts", stub, owned);
  assert.doesNotMatch(out, /HideAll|Refresh|Count/);
  assert.match(out, /StopDirector\(\): void;/);
  assert.equal(filterOwnedManual("BP_Host.d.ts", stub, { "/Fake/Mod/Other": owned[asset]! }), stub);
  assert.equal(filterOwnedManual("BP_Host.d.ts", stub, { [asset]: { units: ["event:Other"], variables: [] } }), stub);
});

test("a unit abfc removed after the stubs were generated stays hidden until the stub folder is rewritten", () => {
  withProject(["event:StopDirectorNew"], (dir) => {
    assert.deepEqual(loadProgram(dir).diagnostics, [], "still listed as hand-made, so the call type-checks");
    const profile = join(dir, ".abfc", "stubs", "p");
    mkdirSync(profile, { recursive: true });
    writeRetired(profile, asset, ["event:StopDirector"]);
    writeRetired(profile, asset, ["event:StopDirector", "function:Gone"]);
    assert.deepEqual(readRetired(dir), { [asset]: ["event:StopDirector", "function:Gone"] });
    const { diagnostics } = loadProgram(dir);
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    assert.equal(diagnostics[0]!.span?.line, CALL_LINE);
    rmSync(profile, { recursive: true });
    assert.deepEqual(readRetired(dir), {});
    assert.deepEqual(loadProgram(dir).diagnostics, []);
  });
});

test("a corrupt retired.json is ignored with a warning instead of a raw JSON exception", () => {
  withProject(["event:StopDirectorNew"], (dir) => {
    const profile = join(dir, ".abfc", "stubs", "p");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "retired.json"), "{ not json", "utf8");
    const warned: string[] = [];
    assert.deepEqual(readRetired(dir, "p", (file) => warned.push(file)), {});
    assert.equal(warned.length, 1);
    assert.deepEqual(readRetired(dir, "other"), {}, "only the named profile is read");
    const { diagnostics } = loadProgram(dir);
    assert.equal(diagnostics.length, 1, JSON.stringify(diagnostics));
    assert.equal(diagnostics[0]!.severity, "warning");
    assert.match(diagnostics[0]!.message, /ignoring unreadable .*retired\.json/);
    writeRetired(profile, asset, ["event:StopDirector"]);
    assert.deepEqual(readRetired(dir), { [asset]: ["event:StopDirector"] });
  });
});
