// "Careless modder" scenarios on the fake backend: the regression tests of the live scenario runs (see docs/known-issues.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TA, tally, tallyOnly, withRig } from "./rig.js";

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
