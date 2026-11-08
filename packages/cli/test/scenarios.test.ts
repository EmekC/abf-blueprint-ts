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

test("(S10) an asset saved in the Mod Editor that the stage had not touched makes the next build re-sync the stage (ABFC4017)", async () => {
  await withRig({ handMadeEvent: false }, async (r) => {
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const syncs = r.backend.calls.filter((c) => c.tool === "staging_sync").length;
    r.backend.stageStale = ["Content/Relay/BP_Relay.uasset"];

    x = await r.run(["status"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4020/);
    assert.equal(r.backend.calls.filter((c) => c.tool === "staging_sync").length, syncs, "status never re-syncs");

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4017/);
    assert.match(x.out, /BP_Relay\.uasset/);
    assert.equal(r.backend.calls.filter((c) => c.tool === "staging_sync").length, syncs + 1);

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC4017/);
  });
});

test("(S13) unsaved-changes refusal then conflict re-sync publishes", async () => {
  await withRig({ ...OPS }, async (r) => {
    r.backend.keepAssetsOnSync = true;
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);

    // the editor holds an unsaved change: bp_publish refuses and copies nothing
    const ok = r.backend.publishResult;
    r.backend.publishResult = {
      ...ok,
      ok: false,
      published: [],
      refused: "editor refused",
      editorReason: "modified assets (unsaved changes)",
      message: "Refused by the open editor: /TestMod/BP_Tally (modified assets (unsaved changes)). Save or revert those assets, then publish again. Nothing was copied.",
    };
    x = await r.run(["publish"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC7005/);
    assert.match(x.out, /save or revert those assets/);
    assert.match(x.out, /BP_Tally/);
    assert.equal(r.backend.publishCalls.length, 1);

    // the modder saves the asset in the editor (with a hand-made function): the real file differs from the stage's baseline
    r.backend.addHandMadeFunction(TA, "HandFn");
    r.backend.stageConflicts = ["Content/BP_Tally.uasset"];
    r.backend.publishResult = ok;
    const syncs = r.backend.calls.filter((c) => c.tool === "staging_sync").length;
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC4017/);
    assert.match(x.out, /BP_Tally\.uasset/);
    assert.equal(r.backend.calls.filter((c) => c.tool === "staging_sync").length, syncs + 1, "the stage was re-synced once");
    assert.match(x.out, /warning ABFC5014/);
    assert.deepEqual(r.backend.functionNames(TA), [], "the hand-made function is removed (TS wins)");
    assert.equal(r.backend.publishCalls.length, 2, "the second publish reached the backend");
    assert.equal(r.backend.stageConflicts.length, 0);

    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /nothing to publish/);
  });
});

test("(S16) Play In Editor running: publish is refused with a clear message, after stopping it publishes", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);

    const ok = r.backend.publishResult;
    r.backend.publishResult = {
      ...ok,
      ok: false,
      published: [],
      refused: "editor refused",
      editorReason: "Play In Editor is running",
      message: "Refused by the open editor: /TestMod/BP_Tally (Play In Editor is running). Stop Play In Editor, then publish again. Nothing was copied.",
    };
    x = await r.run(["publish"]);
    assert.equal(x.code, 3, x.out);
    assert.match(x.out, /error ABFC7005/);
    assert.match(x.out, /Stop Play In Editor/);
    assert.match(x.out, /fix: stop Play In Editor in the Mod Editor/);

    r.backend.publishResult = ok;
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    x = await r.run(["publish"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /nothing to publish/);
  });
});

test("(S14) a field whose variable the Mod Editor retyped (renamed class) is recreated with the TS type", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    const before = appliedSpecs(r).length;
    r.backend.setVariableType(TA, "Total", "float");
    r.backend.stageConflicts = ["Content/BP_Tally.uasset"];
    r.backend.keepAssetsOnSync = true;

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC2047/);
    assert.match(x.out, /warning ABFC5014: TypeScript wins: the variable Total had the type float/);
    const specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.ok(specs.some((s) => (s.remove_variables ?? []).includes("Total")), JSON.stringify(specs));
    assert.ok(specs.some((s) => (s.variables ?? []).some((v: any) => /Total/.test(JSON.stringify(v)))), JSON.stringify(specs));

    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC5014/);
  });
});

test("(S20) a retyped field is recreated, its units are re-applied and the next build is up to date", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.backend.variableNames(TA).filter((n) => !n.startsWith("abfc_")), ["Total"]);
    const before = appliedSpecs(r).length;

    // Total: int -> float (the event parameter follows so the assignment type-checks)
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally").replace("import type { int }", "import type { int, float }").replace("Total!: int;", "Total!: float;").replace("Bump(by: int)", "Bump(by: float)"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC2047: .*changed the type of own field Total \(int -> float\): the variable is recreated/);
    const specs = appliedSpecs(r).slice(before).filter((s) => s.asset === TA);
    assert.ok(specs.some((s) => (s.remove_variables ?? []).includes("Total")), JSON.stringify(specs));
    assert.ok(specs.some((s) => (s.variables ?? []).some((v: any) => v.name === "Total" && /float|real|double/.test(v.type))), JSON.stringify(specs));
    assert.ok(specs.some((s) => (s.graphs ?? []).length > 0), "the unit is applied again");
    assert.equal(r.backend.variableType(TA, "Total").includes("int"), false);
    assert.equal(readManifest(r.dir, TA)?.variables.find((v) => v.name === "Total")?.type.includes("int"), false);

    const again = appliedSpecs(r).length;
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.doesNotMatch(x.out, /ABFC2047/);
    assert.equal(appliedSpecs(r).length, again, "nothing is applied again");
  });
});

test("(S19) adding a field adds a variable; removing it removes the variable (ABFC5011) and the next build is up to date", async () => {
  await withRig({ ...OPS }, async (r) => {
    tallyOnly(r.dir, tally("BP_Tally"));
    let x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally").replace("  Total!: int;", "  Total!: int;\n  Armed!: boolean;"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.deepEqual(r.backend.variableNames(TA).filter((n) => !n.startsWith("abfc_")).sort(), ["Armed", "Total"]);
    x = await r.run(["build"]);
    assert.match(x.out, /up to date/);

    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 0, x.out);
    assert.match(x.out, /warning ABFC5011: removed own field Armed/);
    assert.deepEqual(r.backend.variableNames(TA).filter((n) => !n.startsWith("abfc_")), ["Total"]);
    x = await r.run(["build"]);
    assert.doesNotMatch(x.out, /ABFC5011/);
    assert.match(x.out, /up to date/);

    // a field with a default is refused with a clear message and nothing is applied
    const before = appliedSpecs(r).length;
    writeFileSync(join(r.dir, "src", "Tally.ts"), tally("BP_Tally").replace("  Total!: int;", "  Total!: int;\n  Speed: number = 2.5;"), "utf8");
    x = await r.run(["build"]);
    assert.equal(x.code, 1, x.out);
    assert.match(x.out, /error ABFC2047: field Speed: an own field is declared as `Name!: Type;`/);
    assert.equal(appliedSpecs(r).length, before);
  });
});
