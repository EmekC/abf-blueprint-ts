// "Careless modder" scenarios on the fake backend: the regression tests of the live scenario runs (see docs/known-issues.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, readSourceMap } from "@abfc/compiler";
import { OPS, TA, addParentStubs, tally, tallyOnly, withRig } from "./rig.js";

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

test("(S05) a rename or reparent that edits the asset's nodes is replaced without the ABFC5014 editor-edit warning", async () => {
  await withRig(OPS, async (r) => {
    addParentStubs(r.dir);
    tallyOnly(r.dir, tally("BP_Zed"));
    assert.equal((await r.run(["build"])).code, 0);
    r.backend.opsEditNodes = true;
    // renamed (class, same file): the fixup edits a node, the unit is re-applied, no warning blames the modder
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Zed2"), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /renamed \/TestMod\/BP_Zed -> \/TestMod\/BP_Zed2/);
    assert.doesNotMatch(x.out, /ABFC5014/);
    const afterRename = r.backend.applyLabels().length;
    // reparented
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Zed2", "Pawn"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /reparented /);
    assert.doesNotMatch(x.out, /ABFC5014/);
    assert.ok(r.backend.applyLabels().length > afterRename, "the units were applied again");
  });
});

test("(S06) recreating a moved class keeps the old path to delete on publish", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    addParentStubs(r.dir);
    tallyOnly(r.dir, tally("BP_Tally"));
    assert.equal((await r.run(["build"])).code, 0);
    r.backend.markPublished();
    // moved into a folder, then the family changes before anything was published
    mkdirSync(join(r.dir, "src", "Sub"));
    renameSync(join(r.dir, "src", "Tally.ts"), join(r.dir, "src", "Sub", "Tally.ts"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /renamed \/TestMod\/BP_Tally -> \/TestMod\/Sub\/BP_Tally/);
    writeFileSync(join(r.dir, "src", "Sub", "Tally.ts"), tally("BP_Tally", "ActorComponent"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /recreating \/TestMod\/Sub\/BP_Tally/);
    assert.equal(readManifest(r.dir, "/TestMod/Sub/BP_Tally")!.renamedFrom, TA, "the recreated asset still knows the path it moved from");
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /deleted Content\/BP_Tally\.uasset/);
    assert.equal(r.backend.removedFiles.size, 0);
    assert.equal(readManifest(r.dir, "/TestMod/Sub/BP_Tally")!.renamedFrom, undefined);
  });
});

test("(S08) a second publish publishes nothing and keeps the manifests", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    assert.equal((await r.run(["build"])).code, 0);
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally2"), "utf8");
    assert.equal((await r.run(["build"])).code, 0);
    let x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.equal(r.backend.publishCalls.length, 1);
    const manifest = JSON.stringify(readManifest(r.dir, "/TestMod/BP_Tally2"));
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /nothing to publish/);
    assert.equal(r.backend.publishCalls.length, 1, "the second publish did not call the backend");
    assert.equal(JSON.stringify(readManifest(r.dir, "/TestMod/BP_Tally2")), manifest);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Tally2")!.renamedFrom, undefined);
  });
});

const holder = (withTarget: boolean): string =>
  [
    'import { blueprint } from "@abfc/runtime";',
    'import type { int } from "@abfc/runtime";',
    'import { Actor } from "/Script/FakeEngine";',
    ...(withTarget ? ['import { BP_Zed } from "./Tally.js";'] : []),
    "",
    "@blueprint()",
    "export class BP_Alpha extends Actor {",
    "  Count!: int;",
    ...(withTarget ? ["  Other!: BP_Zed | null;"] : []),
    "}",
    "",
  ].join(String.fromCharCode(10));

test("(S07b) deleting a class and its last TS use in one build", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), holder(true), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    // the class and the field that uses it go in the same edit
    rmSync(join(r.dir, "src", "Tally.ts"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), holder(false), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC5016/);
    assert.match(x.out, /deleted \/TestMod\/BP_Zed/);
    assert.deepEqual(r.backend.stageAssets().filter((a) => a.includes("Zed")), []);
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed")!.deleted, true);
    assert.deepEqual(readManifest(r.dir, "/TestMod/BP_Alpha")!.variables.map((v) => v.name), ["Count"]);
    // the next build has nothing to do, and a publish deletes the file
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /up to date/);
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
  });
});

test("(S07c) a class that a hand-made asset still references is not deleted, and the stage is restored", async () => {
  await withRig({ ...OPS, publishDeletes: true }, async (r) => {
    tallyOnly(r.dir, tally("BP_Zed"));
    writeFileSync(join(r.dir, "src", "BP_Alpha.ts"), holder(false), "utf8");
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    r.backend.addHandMadeReference("/TestMod/BP_Hand", "/TestMod/BP_Zed");
    rmSync(join(r.dir, "src", "Tally.ts"));
    x = await r.run(["build"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /ABFC5016/);
    assert.match(x.out, /still referenced by \/TestMod\/BP_Hand/);
    assert.ok(r.backend.stageAssets().includes("/TestMod/BP_Zed"), "the stage still has the class");
    assert.equal(readManifest(r.dir, "/TestMod/BP_Zed")!.deleted, undefined);
  });
});
