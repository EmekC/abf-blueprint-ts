import type { TestCase } from "@abfc/ir";

/** The `bp_game_test` steps of a compiled test, in order. */
export function toGameTestSteps(tc: TestCase): unknown[] {
  return tc.steps.map((s) => s.step);
}
