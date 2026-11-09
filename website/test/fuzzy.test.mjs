// The docs search matcher: key letters, node names, TypeScript names and qualified names all find the right entry.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { search } from "../lib/fuzzy.mjs";

const entry = (tsName, title, owner, text) => ({
  kind: "node",
  title,
  tsName,
  qualified: `${owner}.${tsName}`,
  text,
  url: `/abf-blueprint-ts/reference/nodes/${owner.toLowerCase()}-${tsName.toLowerCase()}/`,
});

const ENTRIES = [
  entry("PrintString", "Print String", "KismetSystemLibrary", "Writes a message to the output log"),
  entry("PrintText", "Print Text", "KismetSystemLibrary", "Writes a text value to the output log"),
  entry("K2_SetTimerDelegate", "Set Timer by Event", "KismetSystemLibrary", "Calls an event after a delay"),
  entry("K2_GetPawn", "Get Controlled Pawn", "Controller", "Returns the pawn the controller possesses"),
  entry("GetPlayerController", "Get Player Controller", "GameplayStatics", "Returns the local player controller"),
];

const names = (q) => search(ENTRIES, q).map((e) => e.tsName);

describe("docs search", () => {
  it("finds Print String first by key letters, node name, partial and TypeScript name", () => {
    for (const q of ["prst", "print string", "printstr", "PrintString"]) assert.equal(names(q)[0], "PrintString", q);
  });

  it("finds the timer node by part of its name", () => {
    for (const q of ["settimer", "timer", "settimerbyevent", "sett"]) assert.ok(names(q).includes("K2_SetTimerDelegate"), q);
    assert.equal(names("settimer")[0], "K2_SetTimerDelegate");
    assert.equal(names("settimerbyevent")[0], "K2_SetTimerDelegate");
  });

  it("finds a node by a word of its Blueprint name", () => {
    assert.equal(names("controlledpawn")[0], "K2_GetPawn");
  });

  it("finds a node by its qualified name", () => {
    assert.equal(names("kismetsystemlibrary.prints")[0], "PrintString");
  });

  it("prefers documented and usable nodes on equal scores", () => {
    const e = (tsName, extra) => ({ ...entry(tsName, "Move Thing", "Mover", ""), ...extra });
    const found = search([e("MoveA", { blocked: 1 }), e("MoveB", {}), e("MoveC", { doc: 1 })], "move thing").map((x) => x.tsName);
    assert.deepEqual(found, ["MoveC", "MoveB", "MoveA"]);
  });

  it("returns nothing for text that matches nothing", () => {
    assert.deepEqual(names("zzzz"), []);
    assert.deepEqual(names("   "), []);
  });
});
