import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProgram, stubDescriptionAt, tsQuickInfoAt } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase4Dir = fileURLToPath(new URL("../../test/fixtures/phase4", import.meta.url));

const source = `import { blueprint, event } from "@abfc/runtime";
import type { int } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Phase4/BP_Hover" })
export class BP_Hover extends Actor {
  @event
  Go(): void {
    const local: int = 3;
    this.K2_DestroyActor();
    this.ReceiveBeginPlay();
    if (local > 1) return;
  }
}
`;

/** phase4 with a described stub member (K2_DestroyActor) and a source file that uses it. */
function withProject(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(here, "hover-"));
  try {
    cpSync(phase4Dir, dir, { recursive: true });
    const stubFile = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
    const stub = readFileSync(stubFile, "utf8").replace(
      "  /**\n   * @bpPath /Script/FakeEngine.Actor:K2_DestroyActor\n",
      "  /**\n   * Destroys this actor.\n   * Second line of the description.\n   * @bpPath /Script/FakeEngine.Actor:K2_DestroyActor\n",
    );
    assert.match(stub, /Destroys this actor\./, "the stub was patched");
    writeFileSync(stubFile, stub, "utf8");
    writeFileSync(join(dir, "src", "Hover.ts"), source, "utf8");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const at = (text: string, needle: string, inside = 1): number => text.indexOf(needle) + inside;

test("stubDescriptionAt returns the first description line of a stub member, and nothing for a local", () => {
  withProject((dir) => {
    const loaded = loadProgram(dir);
    const sf = loaded.program.getSourceFile(join(dir, "src", "Hover.ts"));
    assert.ok(sf);
    assert.equal(stubDescriptionAt(loaded, sf, at(sf.text, "K2_DestroyActor", 3)), "Destroys this actor.");
    assert.equal(stubDescriptionAt(loaded, sf, at(sf.text, "ReceiveBeginPlay", 3)), undefined, "a stub member without a description");
    assert.equal(stubDescriptionAt(loaded, sf, at(sf.text, "local > 1", 1)), undefined, "a local variable is not a stub symbol");
    assert.equal(stubDescriptionAt(loaded, sf, at(sf.text, "{\n  @event", 0)), undefined, "no identifier there");
  });
});

test("tsQuickInfoAt returns `name: type` for a local and undefined between tokens", () => {
  withProject((dir) => {
    const loaded = loadProgram(dir);
    const sf = loaded.program.getSourceFile(join(dir, "src", "Hover.ts"));
    assert.ok(sf);
    const info = tsQuickInfoAt(loaded, sf, at(sf.text, "local > 1", 1));
    assert.ok(info !== undefined);
    assert.match(info, /^local: /);
    assert.equal(tsQuickInfoAt(loaded, sf, at(sf.text, "{\n  @event", 0)), undefined);
  });
});
