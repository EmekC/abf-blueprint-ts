// The website's copies of editor logic (node names, page slugs, name matching) agree with the compiled packages.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { matchName } from "../lib/fuzzy.mjs";
import { displayNameOf, nodeSlug } from "../lib/nodes.mjs";
import { BASE, SITE } from "../site.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const { displayNameOf: irDisplayNameOf } = await load("packages/ir/dist/src/index.js");
const { nodeDocsSlug, DOCS_SITE_URL } = await load("packages/lsp/dist/src/docs.js");
const completions = await load("packages/compiler/dist/src/frontend/completions.js");
const signatures = JSON.parse(readFileSync(join(root, "website", "data", "node-signatures.json"), "utf8"));

describe("website and packages agree", () => {
  it("uses the same site URL as the language server", () => {
    assert.equal(`${SITE}${BASE}/`, DOCS_SITE_URL);
  });

  it("names nodes and pages the same way for every stub function", () => {
    for (const key of Object.keys(signatures.functions)) {
      assert.equal(nodeSlug(key), nodeDocsSlug(key), key);
      const fn = key.slice(key.indexOf(":") + 1);
      assert.equal(displayNameOf(fn), irDisplayNameOf(fn), fn);
    }
  });

  it("matches names like the editor completion", () => {
    const names = [
      ["PrintString", "Print String"],
      ["K2_SetTimerDelegate", "Set Timer by Event"],
      ["K2_GetPawn", "Get Controlled Pawn"],
      ["BP_Spawn", undefined],
      ["GetPlayerController", "Get Player Controller"],
    ];
    const queries = ["p", "pr", "prin", "printstring", "set", "settimer", "timer", "pawn", "controlled", "getplayer", "spawn", "bp_s", "zzz", "string"];
    for (const [name, display] of names) {
      for (const q of queries) assert.deepEqual(matchName(name, display, q), completions.matchName(name, display, q), `${name} ~ ${q}`);
    }
  });
});
