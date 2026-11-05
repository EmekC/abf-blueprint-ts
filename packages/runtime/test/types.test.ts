import { test } from "node:test";
import assert from "node:assert/strict";
import type { double, int, name, text } from "../src/index.js";

// Compile-time checks only: this function is never called.
export function typeChecks(someInt: int, someText: text): void {
  const d: double = 0;
  // @ts-expect-error flavors do not mix
  const x: double = someInt;
  const n1: name = "Row";
  // @ts-expect-error a text value is not a name
  const n: name = someText;
  void [d, x, n1, n];
}

test("flavored types compile", () => {
  assert.equal(typeof typeChecks, "function");
});
