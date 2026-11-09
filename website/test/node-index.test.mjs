// The committed node index (website/data/node-signatures.json) and the search over all of it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { search } from "../lib/fuzzy.mjs";
import { buildNodes, llmsNodesText } from "../lib/nodes.mjs";
import { buildSearchIndex } from "../lib/search-index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const descriptions = JSON.parse(read("packages/stubgen/data/descriptions.json"));
const signatures = JSON.parse(read("website/data/node-signatures.json"));
const BASE = "/abf-blueprint-ts";
const nodes = buildNodes(descriptions, signatures, BASE);
const index = buildSearchIndex({ nodes, runtimeMd: read("docs/runtime.md"), errorsMd: read("docs/errors.md"), pages: [], base: BASE });
const first = (q) => search(index.entries, q)[0]?.qualified;

describe("node index data", () => {
  it("is version 2, from generator 0.7.0 or later, /Script keys only", () => {
    assert.equal(signatures.version, 2);
    const [major, minor] = signatures.generator.split(".").map(Number);
    assert.ok(major > 0 || minor >= 7, signatures.generator);
    for (const key of Object.keys(signatures.functions)) assert.ok(key.startsWith("/Script/"), key);
  });

  it("holds no local paths", () => {
    const text = JSON.stringify(signatures);
    assert.ok(!text.includes("Users\\\\") && !text.includes("/Users/"));
  });

  it("has every curated function and a UMG function", () => {
    for (const key of Object.keys(descriptions.functions)) assert.ok(key in signatures.functions, key);
    assert.ok("/Script/UMG.UserWidget:AddToViewport" in signatures.functions);
  });
});

describe("search over every node", () => {
  it("stays small enough to ship", () => {
    assert.ok(JSON.stringify(index).length < 1_200_000);
  });

  it("finds the node by its name, key letters or TypeScript name", () => {
    for (const q of ["prst", "print string", "printstr"]) assert.equal(first(q), "KismetSystemLibrary.PrintString", q);
    for (const q of ["settimer", "settimerbyevent"]) assert.equal(first(q), "KismetSystemLibrary.K2_SetTimerDelegate", q);
    for (const q of ["activate jetpack", "actjet"]) assert.equal(first(q), "AbioticCharacter.Aim", q);
    for (const q of ["add to viewport", "addvp"]) assert.equal(first(q), "UserWidget.AddToViewport", q);
    assert.equal(first("getplayercontroller"), "GameplayStatics.GetPlayerController");
    assert.equal(first("delay"), "KismetSystemLibrary.Delay");
  });

  it("lists every function in llms-nodes.txt", () => {
    const text = llmsNodesText(nodes, "https://example.test/abf-blueprint-ts", { generator: signatures.generator, modEditorVersion: signatures.modEditorVersion });
    assert.ok(/^- \[Print String\]/m.test(text));
    assert.ok(text.length < 1_500_000);
  });
});
