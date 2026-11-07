import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeEntryName, readZip, writeZip } from "../src/index.js";

const text = (s: string): Buffer => Buffer.from(s, "utf8");

test("zip: round trip with stored, deflated and UTF-8 entries", () => {
  const big = text("abc".repeat(5000));
  const zip = writeZip([
    { name: "a/big.txt", data: big },
    { name: "a/tiny.bin", data: Buffer.from([1]) },
    { name: "empty.txt", data: Buffer.alloc(0) },
    { name: "uml\u00e4ut/\u00fc.txt", data: text("hi") },
  ]);
  const entries = readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["a/big.txt", "a/tiny.bin", "empty.txt", "uml\u00e4ut/\u00fc.txt"]);
  assert.equal(entries[0]!.method, 8);
  assert.ok(entries[0]!.compressedSize < big.length);
  assert.equal(entries[1]!.method, 0);
  assert.equal(entries[2]!.method, 0);
  assert.deepEqual(entries[0]!.read(), big);
  assert.deepEqual(entries[1]!.read(), Buffer.from([1]));
  assert.equal(entries[2]!.read().length, 0);
  assert.equal(entries[3]!.read().toString("utf8"), "hi");
});

test("zip: output is deterministic", () => {
  const input = [{ name: "x.txt", data: text("x".repeat(100)) }, { name: "y.txt", data: text("y") }];
  assert.deepEqual(writeZip(input), writeZip(input));
});

test("zip: a corrupted byte is detected by the CRC or the inflater", () => {
  const data = text("stored content that is not compressible: 0123456789");
  const zip = writeZip([{ name: "s.txt", data: Buffer.from([7, 8, 9]) }, { name: "f.txt", data }], { level: 0 });
  const entries = readZip(zip);
  const stored = entries.find((e) => e.method === 0)!;
  const bad = Buffer.from(zip);
  const at = bad.indexOf(Buffer.from([7, 8, 9]));
  bad[at] = 99;
  const badEntry = readZip(bad).find((e) => e.name === stored.name)!;
  assert.throws(() => badEntry.read(), /CRC mismatch/);
});

test("zip: zip64 markers and encryption are refused", () => {
  const zip = writeZip([{ name: "a.txt", data: text("a") }]);
  const eocd = zip.length - 22;
  const z64 = Buffer.from(zip);
  z64.writeUInt16LE(0xffff, eocd + 10);
  assert.throws(() => readZip(z64), /zip64/);
  const enc = Buffer.from(zip);
  const cd = enc.readUInt32LE(eocd + 16);
  enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
  assert.throws(() => readZip(enc), /encrypted/);
  const big = Buffer.from(zip);
  big.writeUInt32LE(0xffffffff, cd + 20);
  assert.throws(() => readZip(big), /zip64/);
});

test("zip: unsupported methods are refused", () => {
  const zip = writeZip([{ name: "a.txt", data: text("a") }]);
  const cd = zip.readUInt32LE(zip.length - 22 + 16);
  zip.writeUInt16LE(12, cd + 10);
  assert.throws(() => readZip(zip), /unsupported method/);
});

test("zip: unsafe and duplicate names are refused by the writer", () => {
  for (const name of ["", "/abs.txt", "a\\b.txt", "C:/x.txt", "c:x.txt", "../x.txt", "a/../x.txt", "a//b.txt", "./x.txt", "a/./b"]) {
    assert.throws(() => writeZip([{ name, data: text("x") }]), /unsafe entry name/, name);
  }
  assert.throws(() => writeZip([{ name: "a.txt", data: text("1") }, { name: "a.txt", data: text("2") }]), /duplicate/);
  assert.throws(() => writeZip([{ name: "a.txt", data: text("1") }, { name: "A.TXT", data: text("2") }]), /duplicate/);
});

/** Rewrites a name inside a finished zip (local and central headers) without changing its length. */
function renameInZip(zip: Buffer, from: string, to: string): Buffer {
  assert.equal(from.length, to.length);
  return Buffer.from(zip.toString("latin1").replaceAll(from, to), "latin1");
}

test("zip: unsafe names are refused by the reader", () => {
  const zip = writeZip([{ name: "ab/cd.txt", data: text("x") }]);
  for (const bad of ["../cd.txt", "ab\\cd.txt", "/b/cd.txt", "C:/cd.txt", "ab//d.txt", "a/./d.txt"]) {
    assert.throws(() => readZip(renameInZip(zip, "ab/cd.txt", bad)), /unsafe entry name/, bad);
  }
});

test("zip: directory entries are skipped, a missing end record is an error", () => {
  const zip = writeZip([{ name: "dd", data: Buffer.alloc(0) }, { name: "f.txt", data: text("x") }]);
  const withDir = renameInZip(zip, "dd", "d/");
  assert.deepEqual(readZip(withDir).map((e) => e.name), ["f.txt"]);
  assert.throws(() => readZip(Buffer.from("not a zip file at all, really not")), /end of central directory/);
});

test("isSafeEntryName", () => {
  assert.equal(isSafeEntryName("a/b.txt"), true);
  assert.equal(isSafeEntryName(".abfc"), true);
  assert.equal(isSafeEntryName("a..b/c"), true);
  assert.equal(isSafeEntryName("a/"), false);
  assert.equal(isSafeEntryName("a/b/"), false);
});
