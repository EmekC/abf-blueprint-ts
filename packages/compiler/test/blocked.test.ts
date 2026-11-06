import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockedMemberHits, loadProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));

const HIT = `import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_Hit" })
export class BP_Hit extends Actor {
  @event
  Go(): void {
    this.K2_Blocked();
    this.K2_DestroyActor();
  }
}
`;

test("blockedMemberHits: a use of a member tagged `@deprecated Blocked by Blueprint filter` is ABFC7011; others are not", () => {
  const dir = mkdtempSync(join(here, "blocked-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    const stub = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
    const text = readFileSync(stub, "utf8");
    writeFileSync(
      stub,
      text.replace(
        "K2_DestroyActor(): void;",
        "K2_DestroyActor(): void;\n  /** @bpPath /Script/FakeEngine.Actor:K2_Blocked\n   * @deprecated Blocked by Blueprint filter: Block R1 */\n  K2_Blocked(): void;",
      ),
      "utf8",
    );

    const clean = blockedMemberHits(loadProgram(dir));
    assert.deepEqual(clean, [], "no source uses the blocked member yet");

    writeFileSync(join(dir, "src", "Hit.ts"), HIT, "utf8");
    const hits = blockedMemberHits(loadProgram(dir));
    assert.equal(hits.length, 1, JSON.stringify(hits));
    const d = hits[0]!;
    assert.equal(d.code, "ABFC7011");
    assert.equal(d.severity, "error");
    assert.match(d.message, /K2_Blocked/);
    assert.equal(d.span?.file, "src/Hit.ts");
    assert.equal(d.span?.line, 8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
