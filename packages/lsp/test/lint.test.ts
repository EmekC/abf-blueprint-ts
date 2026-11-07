import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProgram } from "@abfc/compiler";
import { copyFixture, open, sleep, startInMemory } from "./helpers.js";

const TICKER = `import { blueprint, override } from "@abfc/runtime";
import { Actor } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_Ticker" })
export class BP_Ticker extends Actor {
  Count = 0;

  @override
  ReceiveTick(dt: number): void {
    for (let i = 0; i < 3; i++) {
      this.Count = this.Count + dt;
    }
  }
}
`;

const withTicker = (dir: string): void => writeFileSync(join(dir, "src", "Ticker.ts"), TICKER, "utf8");

const abfcLint = (ds: Array<{ code?: string | number | undefined }>): Array<{ code?: string | number | undefined }> => ds.filter((d) => String(d.code).startsWith("abfc/"));

test("lint: a loop in a tick override is reported with the rule id and the rule's documentation link", async () => {
  const dir = copyFixture("project", withTicker);
  const started = await startInMemory();
  try {
    const uri = open(started.client, join(dir, "src", "Ticker.ts"));
    const ds = await started.client.waitForDiagnostics(uri, (x) => x.some((d) => d.code === "abfc/no-loop-in-tick"));
    const d = ds.find((x) => x.code === "abfc/no-loop-in-tick");
    assert.ok(d);
    assert.equal(d.source, "abfc");
    assert.equal(d.severity, 2, "recommended rules are warnings");
    assert.match(d.message, /ReceiveTick/);
    assert.match(d.codeDescription?.href ?? "", /docs\/lint-rules\.md#no-loop-in-tick$/);
    assert.equal(d.range.start.line, 9, "the finding is on the `for` line (0-based)");
    assert.deepEqual(started.client.protocolErrors, []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint: a clean file has no lint findings", async () => {
  const dir = copyFixture("project", withTicker);
  const started = await startInMemory();
  try {
    const uri = open(started.client, join(dir, "src", "Relay.ts"));
    const ds = await started.client.waitForDiagnostics(uri);
    assert.deepEqual(abfcLint(ds), []);
    // the other file with findings is checked in the same project: a publish for it arrives too, so the lint ran in this server
    const ticker = open(started.client, join(dir, "src", "Ticker.ts"));
    const tds = await started.client.waitForDiagnostics(ticker, (x) => x.some((d) => d.code === "abfc/no-loop-in-tick"));
    assert.equal(abfcLint(tds).length, 1);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint: initialization option lint:false turns the rules off", async () => {
  const dir = copyFixture("project", withTicker);
  const started = await startInMemory({ lint: false });
  try {
    const uri = open(started.client, join(dir, "src", "Ticker.ts"));
    const ds = await started.client.waitForDiagnostics(uri);
    assert.deepEqual(abfcLint(ds), []);
    await sleep(300);
    assert.deepEqual(abfcLint(await started.client.waitForDiagnostics(uri)), []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint: findings follow unsaved edits and the position moves with them", async () => {
  const dir = copyFixture("project", withTicker);
  const started = await startInMemory();
  try {
    const uri = open(started.client, join(dir, "src", "Ticker.ts"));
    await started.client.waitForDiagnostics(uri, (x) => x.some((d) => d.code === "abfc/no-loop-in-tick"));
    started.client.forget(uri);
    started.client.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: "// edited\n" }],
    });
    const ds = await started.client.waitForDiagnostics(uri, (x) => x.some((d) => d.code === "abfc/no-loop-in-tick" && d.range.start.line === 10));
    assert.equal(abfcLint(ds).length, 1);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lint: ESLint does not fail on any compiler fixture (a failure is logged as `lint of ...`)", async () => {
  for (const name of ["phase2", "phase3", "phase4", "phase7", "project"]) {
    const dir = copyFixture(name);
    const started = await startInMemory();
    try {
      const logs: string[] = [];
      started.client.onNotification("window/logMessage", (p: { message: string }) => void logs.push(p.message));
      const loaded = loadProgram(dir);
      const files = [...loaded.files.classes, ...loaded.files.tests];
      const uris = files.map((sf) => open(started.client, sf.fileName));
      for (const uri of uris) await started.client.waitForDiagnostics(uri);
      await sleep(50);
      assert.deepEqual(
        logs.filter((l) => l.includes("lint of")),
        [],
        `fixture ${name}`,
      );
    } finally {
      await started.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
