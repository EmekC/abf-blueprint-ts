import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkProject, loadProgram } from "@abfc/compiler";
import { compilerConfigOf, loadProjectEnvironment } from "../src/index.js";
import { pathToUri } from "../src/uri.js";
import { copyFixture, fwd, open, sleep, startInMemory } from "./helpers.js";

const FIXTURES = ["phase2", "phase3", "phase4", "phase7", "project"];

for (const name of FIXTURES) {
  test(`published diagnostics equal checkProject on fixture ${name}`, async () => {
    const dir = copyFixture(name);
    const started = await startInMemory();
    try {
      const env = loadProjectEnvironment(dir);
      const loaded = loadProgram(dir);
      const expected = checkProject(loaded, compilerConfigOf(env.config), env.profile).diagnostics;
      const { client } = started;
      let compared = 0;
      const files = [...loaded.files.classes, ...loaded.files.tests];
      assert.ok(files.length > 0, "the fixture has root files");
      const uris = files.map((sf) => open(client, sf.fileName));
      for (const [i, sf] of files.entries()) {
        const rel = fwd(relative(dir, sf.fileName));
        const want = expected
          .filter((d) => d.span?.file === rel && !d.message.startsWith("[TS"))
          .map((d) => `${d.code}@${d.span?.line}:${d.span?.col}`)
          .sort();
        const got = (await client.waitForDiagnostics(uris[i] as string))
          .filter((d) => String(d.code).startsWith("ABFC"))
          .map((d) => `${d.code}@${d.range.start.line + 1}:${d.range.start.character + 1}`)
          .sort();
        assert.deepEqual(got, want, `diagnostics of ${rel}`);
        compared += want.length;
      }
      if (name === "project") assert.ok(compared > 0, "the project fixture has subset errors to compare");
      assert.deepEqual(client.protocolErrors, []);
    } finally {
      await started.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("diagnostics carry source, code description and the fix text", async () => {
  const dir = copyFixture("project");
  const started = await startInMemory();
  try {
    const uri = open(started.client, join(dir, "src", "Bad.ts"));
    const ds = await started.client.waitForDiagnostics(uri, (x) => x.some((d) => d.code === "ABFC2010"));
    const idiv = ds.find((d) => d.code === "ABFC2010");
    assert.ok(idiv);
    assert.equal(idiv.source, "abfc");
    assert.equal(idiv.severity, 1);
    assert.match(idiv.codeDescription?.href ?? "", /reference\/errors\/#abfc2010$/);
    assert.match(idiv.message, /idiv/);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unsaved change is checked and the disk file stays as it was", async () => {
  const dir = copyFixture("project", (d) => rmSync(join(d, "src", "Bad.ts")));
  const started = await startInMemory();
  try {
    const file = join(dir, "src", "Relay.ts");
    const before = readFileSync(file, "utf8");
    const uri = open(started.client, file);
    const clean = await started.client.waitForDiagnostics(uri);
    assert.ok(!clean.some((d) => d.code === "ABFC2010"), "the file is clean at first");

    const lines = before.split("\n");
    const classLine = lines.findIndex((l) => l.startsWith("export class BP_Relay"));
    const method = "  @event\n  Divide(a: int, b: int): void {\n    const q = a / b;\n  }\n";
    started.client.forget(uri);
    started.client.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [
        { range: { start: { line: classLine + 1, character: 0 }, end: { line: classLine + 1, character: 0 } }, text: method },
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'import type { int } from "@abfc/runtime";\n' },
      ],
    });
    const ds = await started.client.waitForDiagnostics(uri, (x) => x.some((d) => d.code === "ABFC2010"));
    const d = ds.find((x) => x.code === "ABFC2010");
    assert.ok(d);
    // the new text: one import line first, then the method after the class line
    const expectedLine = classLine + 1 + 1 + 2; // class line, +1 for the new import, +1 to the method, `const q` is its third line (0-based 2)
    assert.equal(d.range.start.line, expectedLine);
    assert.equal(d.range.start.character, "    const q = ".length);
    assert.equal(readFileSync(file, "utf8"), before, "the language server never writes the file");
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a project without stubs.lock.json gets ABFC3003 on abf.config.json", async () => {
  const dir = copyFixture("project");
  const started = await startInMemory();
  try {
    open(started.client, join(dir, "src", "Relay.ts"));
    const ds = await started.client.waitForDiagnostics(pathToUri(join(dir, "abf.config.json")), (x) => x.some((d) => d.code === "ABFC3003"));
    const d = ds.find((x) => x.code === "ABFC3003");
    assert.ok(d);
    assert.deepEqual(d.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
    assert.equal(d.source, "abfc");
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config that does not load is published on abf.config.json", async () => {
  const dir = copyFixture("project", (d) => writeFileSync(join(d, "abf.config.json"), "{ not json", "utf8"));
  const started = await startInMemory();
  try {
    const uri = open(started.client, join(dir, "src", "Relay.ts"));
    const ds = await started.client.waitForDiagnostics(pathToUri(join(dir, "abf.config.json")), (x) => x.length > 0);
    assert.equal(ds[0]?.severity, 1);
    assert.match(String(ds[0]?.code), /^ABFC\d+$/);
    assert.deepEqual(await started.client.waitForDiagnostics(uri), [], "no file diagnostics without a config");
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

const withTsError = (d: string): void => appendFileSync(join(d, "src", "Relay.ts"), '\nexport const tsOnly: number = "x";\n', "utf8");

test("TypeScript errors are not published by default", async () => {
  const dir = copyFixture("project", (d) => {
    rmSync(join(d, "src", "Bad.ts"));
    withTsError(d);
  });
  const started = await startInMemory();
  try {
    const uri = open(started.client, join(dir, "src", "Relay.ts"));
    const ds = await started.client.waitForDiagnostics(uri);
    await sleep(200);
    assert.ok(!ds.some((d) => d.code === "ABFC2000"), "no ABFC2000");
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tsDiagnostics: true publishes TypeScript errors as ABFC2000", async () => {
  const dir = copyFixture("project", (d) => {
    rmSync(join(d, "src", "Bad.ts"));
    withTsError(d);
  });
  const started = await startInMemory({ tsDiagnostics: true });
  try {
    const uri = open(started.client, join(dir, "src", "Relay.ts"));
    const ds = await started.client.waitForDiagnostics(uri, (x) => x.some((d) => d.code === "ABFC2000"));
    const ts = ds.find((d) => d.code === "ABFC2000");
    assert.ok(ts);
    assert.match(ts.message, /^\[TS2322\]/);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file outside every project is ignored and the server keeps answering", async () => {
  const dir = copyFixture("project", (d) => rmSync(join(d, "src", "Bad.ts")));
  const outside = mkdtempSync(join(tmpdir(), "abfc-lsp-out-"));
  const started = await startInMemory();
  try {
    const seen: string[] = [];
    started.client.onNotification("textDocument/publishDiagnostics", (p: { uri: string }) => void seen.push(p.uri));
    const stray = join(outside, "stray.ts");
    writeFileSync(stray, "export const x: number = 1;\n", "utf8");
    const strayUri = open(started.client, stray);
    await sleep(500);
    assert.ok(!seen.includes(strayUri), "nothing is published for it");
    // a later document in a project is still served
    const uri = open(started.client, join(dir, "src", "Relay.ts"));
    await started.client.waitForDiagnostics(uri);
    assert.ok(!seen.includes(strayUri));
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("closing the last document clears its diagnostics and the config's", async () => {
  const dir = copyFixture("project");
  const started = await startInMemory();
  try {
    const file = join(dir, "src", "Bad.ts");
    const uri = open(started.client, file);
    await started.client.waitForDiagnostics(uri, (x) => x.length > 0);
    const configUri = pathToUri(join(dir, "abf.config.json"));
    await started.client.waitForDiagnostics(configUri, (x) => x.length > 0);
    started.client.forget(uri);
    started.client.forget(configUri);
    started.client.notify("textDocument/didClose", { textDocument: { uri } });
    assert.deepEqual(await started.client.waitForDiagnostics(uri), []);
    assert.deepEqual(await started.client.waitForDiagnostics(configUri), []);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a document URI with a lower-case, encoded drive letter finds its project", { skip: process.platform !== "win32" }, async () => {
  const dir = copyFixture("project");
  const started = await startInMemory();
  try {
    const file = join(dir, "src", "Bad.ts");
    const uri = pathToUri(file).replace(/^file:\/\/\/([A-Za-z]):/, (_m, drive: string) => `file:///${drive.toLowerCase()}%3A`);
    assert.match(uri, /^file:\/\/\/[a-z]%3A/);
    started.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "typescript", version: 1, text: readFileSync(file, "utf8") },
    });
    const ds = await started.client.waitForDiagnostics(uri, (x) => x.some((d) => d.code === "ABFC2010"));
    assert.ok(ds.length > 0);
  } finally {
    await started.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
