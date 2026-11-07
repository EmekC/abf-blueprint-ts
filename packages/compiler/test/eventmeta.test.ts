import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrModule, IrNode, Profile } from "@abfc/ir";
import { buildHir, featureGates, loadProgram, lower } from "../src/index.js";
import { eventMetaOf } from "../src/lower/eventmeta.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/project and packages/env/profiles
const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;

function lowerWithDoc(doc: string | null): IrModule {
  // inside the package tree so that `@abfc/runtime` still resolves through the workspace node_modules
  const dir = mkdtempSync(join(fileURLToPath(new URL("./", import.meta.url)), "eventmeta-"));
  try {
    cpSync(projectDir, dir, { recursive: true });
    const file = join(dir, "src", "Relay.ts");
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes("  @event\n  UpdateTarget"));
    if (doc !== null) writeFileSync(file, text.replace("  @event\n  UpdateTarget", `${doc}\n  @event\n  UpdateTarget`));
    const loaded = loadProgram(dir);
    const relay = loaded.files.classes.find((f) => f.fileName.endsWith("/Relay.ts"));
    assert.ok(relay);
    const hir = buildHir(loaded, { mod: "TestMod" }, profile, [relay]);
    assert.deepEqual(hir.diagnostics, []);
    return lower(hir, profile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const entry = (ir: IrModule): IrNode => ir.assets[0]!.units[0]!.nodes.find((n) => n.sem?.k === "event")!;

test("eventMetaOf: tooltip lines before the first tag, category and keywords tags", () => {
  assert.equal(eventMetaOf(""), undefined);
  assert.equal(eventMetaOf("@param x nothing"), undefined);
  assert.deepEqual(eventMetaOf("Shows the prompt.\nSecond line.\n\n@category Prompts\n@keywords show hide"), {
    tooltip: "Shows the prompt.\nSecond line.",
    category: "Prompts",
    keywords: "show hide",
  });
  assert.deepEqual(eventMetaOf("@category Only"), { category: "Only" });
  assert.deepEqual(eventMetaOf("One line"), { tooltip: "One line" });
  assert.deepEqual(eventMetaOf("  Padded  \n@category"), { tooltip: "Padded" });
});

test("a documented event gets sem.meta; an undocumented one has none and keeps its hash", () => {
  const plain = lowerWithDoc(null);
  const plainSem = entry(plain).sem!;
  assert.equal(plainSem.k, "event");
  assert.equal("meta" in plainSem, false);

  const documented = lowerWithDoc("  /**\n   * Updates the target.\n   * Second line.\n   * @category Targets\n   * @keywords aim\n   */");
  const sem = entry(documented).sem!;
  assert.equal(sem.k === "event" ? sem.meta?.tooltip : undefined, "Updates the target.\nSecond line.");
  assert.deepEqual(sem.k === "event" ? sem.meta : undefined, {
    tooltip: "Updates the target.\nSecond line.",
    category: "Targets",
    keywords: "aim",
  });
  // meta is in the node sem, so in the unit hash; an undocumented event is byte-identical to a rerun
  assert.notEqual(documented.assets[0]!.units[0]!.hash, plain.assets[0]!.units[0]!.hash);
  assert.equal(lowerWithDoc(null).assets[0]!.units[0]!.hash, plain.assets[0]!.units[0]!.hash);
});

test("gate: ABFC2071 once per documented event without event_meta, none with it", () => {
  const documented = lowerWithDoc("  /** Updates the target. */");
  const plain = lowerWithDoc(null);
  const caps = { containerTypes: { map: true, set: true }, createKinds: ["Blueprint"] };
  const warned = featureGates(documented, caps);
  assert.deepEqual(warned.map((d) => [d.code, d.severity, d.asset]), [["ABFC2071", "warning", "/TestMod/Relay/BP_Relay"]]);
  assert.match(warned[0]!.message, /@event UpdateTarget .*event_meta/);
  assert.ok(warned[0]!.span);
  assert.deepEqual(featureGates(documented, { ...caps, eventMeta: false }).map((d) => d.code), ["ABFC2071"]);
  assert.deepEqual(featureGates(documented, { ...caps, eventMeta: true }), []);
  assert.deepEqual(featureGates(plain, caps), []);
});
