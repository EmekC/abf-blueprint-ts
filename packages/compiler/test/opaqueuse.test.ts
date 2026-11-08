import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProgram, placeholderReceiverAt, placeholderTypesUsed } from "../src/index.js";

// compiled to packages/compiler/dist/test/; the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const phase2Dir = fileURLToPath(new URL("../../test/fixtures/phase2", import.meta.url));

const TEXT = "/Script/FakeEngine.FakeText";
const SLOT = "/Script/FakeEngine.FakeSlot";

const PLACEHOLDERS = `
/**
 * @bpPath ${TEXT}
 * @bpMeta /Script/CoreUObject.Class
 * @bpOpaque
 */
export declare class FakeText extends UObject {}

/**
 * @bpPath ${SLOT}
 * @bpOpaque
 */
export declare class FakeSlot extends UObject {}

/**
 * @bpPath /Script/FakeEngine.FakeUnused
 * @bpOpaque
 */
export declare class FakeUnused extends UObject {}
`;

const MEMBERS =
  "K2_DestroyActor(): void;\n" +
  "  /**\n   * @bpPath /Script/FakeEngine.Actor:Txt\n   * @bpType object:/Script/FakeEngine.FakeText\n   */\n  Txt: FakeText;\n" +
  "  /**\n   * @bpPath /Script/FakeEngine.Actor:Unused\n   * @bpType object:/Script/FakeEngine.FakeUnused\n   */\n  Unused: FakeUnused;";

const USE_MEMBER = `import { blueprint, event } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_Use" })
export class BP_Use extends Actor {
  @event
  Go(): void {
    this.Txt.GetText();
  }
}
`;

const IMPORT_ONLY = `import { FakeSlot } from "/Script/FakeEngine";
export const marker = 1;
`;

const TYPE_USE = `import { FakeSlot } from "/Script/FakeEngine";
export const s: FakeSlot | null = null;
`;

function withProject(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(here, "opaqueuse-"));
  try {
    cpSync(phase2Dir, dir, { recursive: true });
    rmSync(join(dir, "src", "Phase2Bad.ts"));
    const stub = join(dir, ".abfc", "stubs", "test", "Script", "FakeEngine.d.ts");
    const text = readFileSync(stub, "utf8");
    writeFileSync(stub, text.replace("K2_DestroyActor(): void;", MEMBERS) + PLACEHOLDERS, "utf8");
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("placeholderTypesUsed: nothing is used until the source touches a placeholder", () => {
  withProject((dir) => {
    assert.deepEqual(placeholderTypesUsed(loadProgram(dir)), []);
  });
});

test("placeholderTypesUsed: a member access on a placeholder-typed value lists the placeholder, an unused one is not listed", () => {
  withProject((dir) => {
    writeFileSync(join(dir, "src", "Use.ts"), USE_MEMBER, "utf8");
    assert.deepEqual(placeholderTypesUsed(loadProgram(dir)), [TEXT]);
  });
});

test("placeholderTypesUsed: an import alone is skipped, a type annotation counts", () => {
  withProject((dir) => {
    writeFileSync(join(dir, "src", "Imp.ts"), IMPORT_ONLY, "utf8");
    assert.deepEqual(placeholderTypesUsed(loadProgram(dir)), []);
    writeFileSync(join(dir, "src", "Imp.ts"), TYPE_USE, "utf8");
    assert.deepEqual(placeholderTypesUsed(loadProgram(dir)), [SLOT]);
  });
});

test("placeholderReceiverAt: the member name of an access on a placeholder resolves to that placeholder", () => {
  withProject((dir) => {
    writeFileSync(join(dir, "src", "Use.ts"), USE_MEMBER, "utf8");
    const loaded = loadProgram(dir);
    const sf = loaded.program.getSourceFiles().find((f) => f.fileName.endsWith("Use.ts"));
    assert.ok(sf !== undefined, "Use.ts is part of the program");
    const start = sf.text.indexOf("GetText");
    const ph = placeholderReceiverAt(loaded.checker, sf, start, start + "GetText".length);
    assert.deepEqual(ph, { path: TEXT, name: "FakeText" });
    const other = sf.text.indexOf("Go()");
    assert.equal(placeholderReceiverAt(loaded.checker, sf, other, other + 2), undefined);
  });
});
