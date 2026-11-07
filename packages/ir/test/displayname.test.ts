import { test } from "node:test";
import assert from "node:assert/strict";
import { displayNameOf } from "../src/index.js";

test("displayNameOf follows the node editor's name prettifier", () => {
  const vectors: Array<[string, string]> = [
    ["GetAllWidgetsOfClass", "Get All Widgets Of Class"],
    ["K2_GetPawn", "Get Pawn"],
    ["GetHUD", "Get HUD"],
    ["GetHUDClass", "Get HUD Class"],
    ["Conv_FooItemToName", "Conv Foo Item To Name"],
    ["Array_Length", "Array Length"],
    ["Vector2D", "Vector 2D"],
    ["IsValid", "Is Valid"],
    ["Get3Items", "Get 3 Items"],
    ["Plain", "Plain"],
  ];
  for (const [fn, want] of vectors) assert.equal(displayNameOf(fn), want, fn);
});
