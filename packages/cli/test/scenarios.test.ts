// "Careless modder" scenarios on the fake backend: the regression tests of the live scenario runs (see docs/known-issues.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, readSourceMap } from "@abfc/compiler";
import { OPS, TA, tally, tallyOnly, withRig } from "./rig.js";

const appliedSpecs = (r: { backend: { calls: Array<{ tool: string; specs?: Array<Record<string, any>> }> } }): Array<Record<string, any>> =>
  r.backend.calls.filter((c) => c.tool === "bp_apply").flatMap((c) => c.specs ?? []);

test("(S31) intermediate stub graphs are never swept", async () => {
  await withRig({}, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const stubs = r.backend.addIntermediateStubs(TA);
    const before = appliedSpecs(r).length;

    x = await r.run(["build", "--drift"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC5014/);
    for (const g of stubs) assert.doesNotMatch(x.out, new RegExp(g));
    const specs = appliedSpecs(r).slice(before);
    assert.ok(
      specs.every((s) => s.remove_functions === undefined && s.remove_variables === undefined),
      JSON.stringify(specs),
    );
    const removed = specs.flatMap((s) => (s.graphs ?? []).flatMap((g: any) => g.remove ?? []));
    assert.deepEqual(removed, []);
    const held = r.backend.nodeNames(TA);
    assert.ok(held.includes("K2Node_FunctionEntry_0") && held.includes("K2Node_CallFunction_0"), "the stub nodes are still on the stage");
  });
});

test("(S01) a new class is applied after the new class it references, whatever the file names sort like", async () => {
  await withRig({}, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(
      join(r.dir, "src", "BP_Alpha.ts"),
      [
        'import { blueprint } from "@abfc/runtime";',
        'import { Actor } from "/Script/FakeEngine";',
        'import { BP_Zed } from "./Tally.js";',
        "",
        "@blueprint()",
        "export class BP_Alpha extends Actor {",
        "  Other!: BP_Zed | null;",
        "}",
        "",
      ].join(String.fromCharCode(10)),
      "utf8",
    );
    const x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const order = appliedSpecs(r).filter((s) => s.create !== undefined).map((s) => s.asset);
    assert.ok(order.indexOf("/TestMod/BP_Zed") >= 0 && order.indexOf("/TestMod/BP_Zed") < order.indexOf("/TestMod/BP_Alpha"), order.join(","));
  });
});

const referencer = (target: string, file = "./Tally.js"): string =>
  [
    'import { blueprint } from "@abfc/runtime";',
    'import { Actor } from "/Script/FakeEngine";',
    `import { ${target} } from "${file}";`,
    "",
    "@blueprint()",
    "export class BP_Alpha extends Actor {",
    `  Other!: ${target} | null;`,
    "}",
    "",
  ].join(String.fromCharCode(10));

test("(S02) renaming a referenced class does not trip ABFC2047", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), referencer("BP_Zed"), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    // the class is renamed and the referencer follows; the backend's rename fixes the stage variable up
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Zed2"), "utf8");
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), referencer("BP_Zed2"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC2047/);
    assert.match(x.out, /renamed \/TestMod\/BP_Zed -> \/TestMod\/BP_Zed2/);
    const again = r.backend.applyLabels().length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.applyLabels().length, again, "the next build is up to date");
  });
});

test("(S02b) renaming a class and its file together is a rename, not a delete that a referencer blocks", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), referencer("BP_Zed"), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    rmSync(join(r.dir, "src", "Tally.ts"));
    writeFileSync(join(r.dir, "src", "Zed2.ts"), tally("BP_Zed2"), "utf8");
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), referencer("BP_Zed2", "./Zed2.js"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /renamed \/TestMod\/BP_Zed -> \/TestMod\/BP_Zed2/);
    assert.doesNotMatch(x.out, /ABFC5016|ABFC2047/);
    assert.deepEqual(r.backend.assetOpsCalls, [[{ op: "rename", from: "/TestMod/BP_Zed", to: "/TestMod/BP_Zed2" }]]);
    assert.deepEqual(r.backend.stageAssets().filter((a) => a.includes("Zed")), ["/TestMod/BP_Zed2"]);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed"), null);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed2")!.renamedFrom, "/TestMod/BP_Zed");
  });
});

test("(S02c) two new classes and one removed class in a folder are never paired up as a rename", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    rmSync(join(r.dir, "src", "Tally.ts"));
    writeFileSync(join(r.dir, "src", "One.ts"), tally("BP_One"), "utf8");
    writeFileSync(join(r.dir, "src", "Two.ts"), tally("BP_Two"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /renamed /);
    assert.deepEqual(r.backend.assetOpsCalls, [[{ op: "delete", asset: "/TestMod/BP_Zed" }]]);
  });
});

test("(S03) moving a class file keeps the source map's spans on the new file", async () => {
  await withRig(OPS, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const files = (): string[] => {
      const sm = readSourceMap(r.dir, "/TestMod/BP_Zed")!;
      const out = new Set<string>();
      for (const u of Object.values(sm.units)) {
        out.add(u.span.file);
        for (const n of Object.values(u.nodes)) out.add(n.span.file);
      }
      return [...out];
    };
    assert.deepEqual(files(), ["src/Tally.ts"]);
    renameSync(join(r.dir, "src", "Tally.ts"), join(r.dir, "src", "Moved.ts"));
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    assert.deepEqual(files(), ["src/Moved.ts"]);
  });
});
