import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import type { TestCase } from "@abfc/ir";
import { test as kitTest } from "../src/index.js";
import type { TestContext } from "../src/index.js";
import { evaluateTest, toGameTestSteps } from "../src/runner.js";
import type { GameTestReportLike } from "../src/runner.js";

const span = (line: number) => ({ file: "a.test.ts", line, col: 3, endLine: line, endCol: 40 });

function testCase(): TestCase {
  return {
    name: "relay",
    file: "a.test.ts",
    span: span(1),
    steps: [
      { step: { op: "spawn", class: "/TestMod/BP_A.BP_A_C", as: "a" }, span: span(2) },
      { step: { op: "python", as: "u", code: "result=1" }, span: span(3) },
      { step: { op: "assert", value: "$u", equals: 1 }, span: span(4) },
      { step: { op: "assert", value: "$u", approx: 2.5 }, span: span(5), knownIssue: "wrong python name" },
      { step: { op: "assert", value: "$u", contains: "x" }, span: span(6), knownIssue: "flaky" },
    ],
  };
}

function report(over: Partial<GameTestReportLike> = {}): GameTestReportLike {
  return {
    steps: [
      { i: 0, op: "spawn", ok: true, value: null },
      { i: 1, op: "python", ok: true, value: "1" },
      { i: 2, op: "assert", ok: true, value: 1 },
      { i: 3, op: "assert", ok: false, value: 2 },
      { i: 4, op: "assert", ok: true, value: "x" },
    ],
    complete: true,
    timedOut: false,
    runtimeLog: [],
    ...over,
  };
}

nodeTest("toGameTestSteps returns the step objects in order", () => {
  const steps = toGameTestSteps(testCase()) as Array<{ op: string }>;
  assert.deepEqual(steps.map((s) => s.op), ["spawn", "python", "assert", "assert", "assert"]);
});

nodeTest("known issues: failing is ABFC6102, passing is ABFC6103, neither fails the test", () => {
  const r = evaluateTest(testCase(), report());
  assert.equal(r.passed, true);
  assert.deepEqual(r.summary, { ok: 4, failed: 0, knownIssues: 2 });
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.severity, d.span?.line]), [
    ["ABFC6102", "warning", 5],
    ["ABFC6103", "warning", 6],
  ]);
});

nodeTest("a failing assertion is ABFC6101 at the step span with expected and got", () => {
  const rep = report();
  rep.steps[2] = { i: 2, op: "assert", ok: false, value: 7 };
  const r = evaluateTest(testCase(), rep);
  assert.equal(r.passed, false);
  assert.equal(r.summary.failed, 1);
  const d = r.diagnostics.find((x) => x.code === "ABFC6101");
  assert.equal(d?.severity, "error");
  assert.equal(d?.message, "expected 1, got 7 (step 2)");
  assert.equal(d?.span?.line, 4);
});

nodeTest("a step error is reported instead of expected/got", () => {
  const rep = report();
  rep.steps[1] = { i: 1, op: "python", ok: false, value: null, error: "NameError: foo" };
  const r = evaluateTest(testCase(), rep);
  const d = r.diagnostics.find((x) => x.code === "ABFC6101");
  assert.equal(d?.message, "NameError: foo (step 1)");
  assert.equal(r.passed, false);
});

nodeTest("incomplete or timed-out runs are ABFC6104; runtime log lines are ABFC6201 warnings without a span", () => {
  const r = evaluateTest(testCase(), report({ complete: false, timedOut: true, error: "game did not start", runtimeLog: ["LogScript: Error: Accessed None"] }));
  assert.equal(r.passed, false);
  const d = r.diagnostics.find((x) => x.code === "ABFC6104");
  assert.match(d?.message ?? "", /timed out.*game did not start/);
  assert.equal(d?.span?.line, 1);
  const log = r.diagnostics.find((x) => x.code === "ABFC6201");
  assert.equal(log?.severity, "warning");
  assert.equal(log?.span, undefined);
});

nodeTest("a complete report that misses a step is ABFC6104 at that step", () => {
  const rep = report();
  rep.steps.pop();
  const r = evaluateTest(testCase(), rep);
  assert.equal(r.passed, false);
  assert.ok(r.diagnostics.some((d) => d.code === "ABFC6104" && d.span?.line === 6));
});

nodeTest("the user API type-checks and refuses to run in Node", () => {
  class Relay {
    Hp = 1;
    Heal(_amount: number): boolean {
      return true;
    }
  }
  const body = (t: TestContext): void => {
    const r = t.spawn(Relay);
    t.expect(r.call("Heal", 3)).equals(true);
    t.expect(r.get("Hp")).approx(1, 0.1).knownIssue("example");
    r.set("Hp", 2);
    t.wait(0.5);
    t.expect(t.python("result=1", { knownIssue: "example" })).notNone();
  };
  assert.equal(typeof body, "function");
  assert.throws(() => kitTest("x", body), /compiled by abfc, not run/);
});
