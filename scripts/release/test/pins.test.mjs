import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fetchPinned, loadPins, parseShasums, savePins, sha256Buf, sha256File } from "../lib/pins.mjs";

const tmp = mkdtempSync(join(tmpdir(), "abfc-rel-pins-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("pins", () => {
  it("saves and loads pins as 2-space JSON with a trailing newline", () => {
    const file = join(tmp, "pins.json");
    const pins = { schemaVersion: 1, node: { version: "1.2.3", sha256: "" } };
    savePins(file, pins);
    assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(pins, null, 2)}\n`);
    assert.deepEqual(loadPins(file), pins);
  });

  it("hashes buffers and files the same way", () => {
    const file = join(tmp, "a.bin");
    writeFileSync(file, "abc");
    assert.equal(sha256File(file), sha256Buf(Buffer.from("abc")));
    assert.equal(sha256Buf(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("parses a SHASUMS256 list", () => {
    const hex = "a".repeat(64);
    const other = "b".repeat(64);
    const text = `${other}  node-v1.0.0-x64.msi\n${hex.toUpperCase()}  win-x64/node.exe\n`;
    assert.equal(parseShasums(text, "win-x64/node.exe"), hex);
    assert.equal(parseShasums(text, "missing.exe"), null);
  });

  it("verifies an existing file against a non-empty pin", async () => {
    const file = join(tmp, "ok.bin");
    writeFileSync(file, "payload");
    const sha = sha256Buf(Buffer.from("payload"));
    const r = await fetchPinned({ url: "http://invalid.example/x", sha256: sha }, file, { download: false, record: false, what: "ok" });
    assert.deepEqual(r, { path: file, sha256: sha, recorded: false });
  });

  it("records an empty pin only with record, and refuses a mismatch (never overwrites a non-empty pin)", async () => {
    const file = join(tmp, "rec.bin");
    writeFileSync(file, "payload");
    const sha = sha256Buf(Buffer.from("payload"));
    await assert.rejects(
      fetchPinned({ url: "http://invalid.example/x", sha256: "" }, file, { download: false, record: false, what: "rec" }),
      /pin rec is empty: run node scripts\/release\/fetch-pins\.mjs --record \(needs approval\)/,
    );
    const r = await fetchPinned({ url: "http://invalid.example/x", sha256: "" }, file, { download: false, record: true, what: "rec" });
    assert.deepEqual(r, { path: file, sha256: sha, recorded: true });
    await assert.rejects(
      fetchPinned({ url: "http://invalid.example/x", sha256: "0".repeat(64) }, file, { download: false, record: true, what: "rec" }),
      /sha256 mismatch/,
    );
  });

  it("a missing file without download fails with the approval hint and writes nothing", async () => {
    const file = join(tmp, "missing.bin");
    await assert.rejects(
      fetchPinned({ url: "http://invalid.example/x", sha256: "" }, file, { download: false, record: true, what: "missing" }),
      /missing .*missing\.bin: run node scripts\/release\/fetch-pins\.mjs --download \(needs approval\)/,
    );
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.part`), false);
  });
});
