import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripAuthenticode } from "../lib/pe.mjs";

const PE = 0x80;
const OPT = PE + 24;
const DD = OPT + 112; // PE32+ data directories
const SEC = DD + 4 * 8;

/** A synthetic PE32+ image: `body` bytes of payload, optionally followed by a certificate table of `certSize` bytes. */
function makePe({ count = 16, cert = 0, pad = 0, certOff = null }) {
  const headerEnd = 0x400;
  const total = headerEnd + 64 + cert + pad;
  const buf = Buffer.alloc(total);
  buf.writeUInt16LE(0x5a4d, 0);
  buf.writeUInt32LE(PE, 0x3c);
  buf.writeUInt32LE(0x4550, PE);
  buf.writeUInt16LE(0x20b, OPT);
  buf.writeUInt32LE(count, DD - 4);
  buf.fill(0x11, headerEnd, headerEnd + 64);
  if (cert > 0) {
    const off = certOff ?? headerEnd + 64;
    buf.writeUInt32LE(off, SEC);
    buf.writeUInt32LE(cert, SEC + 4);
    buf.fill(0x22, off, off + cert);
  }
  return buf;
}

describe("stripAuthenticode", () => {
  it("truncates the certificate table and zeroes its directory entry", () => {
    const buf = makePe({ cert: 96, pad: 4 });
    const r = stripAuthenticode(buf);
    assert.equal(r.removed, true);
    assert.equal(r.buf.length, 0x400 + 64);
    assert.equal(r.buf.readUInt32LE(SEC), 0);
    assert.equal(r.buf.readUInt32LE(SEC + 4), 0);
    assert.equal(r.buf[0x400], 0x11);
    assert.equal(buf.length, 0x400 + 64 + 96 + 4, "input is not modified");
  });

  it("leaves a file without a certificate table alone", () => {
    const buf = makePe({});
    const r = stripAuthenticode(buf);
    assert.equal(r.removed, false);
    assert.equal(r.buf, buf);
    assert.equal(stripAuthenticode(makePe({ count: 4 })).removed, false);
  });

  it("throws when the certificate table is not at the end of the file", () => {
    assert.throws(() => stripAuthenticode(makePe({ cert: 32, pad: 64 })), /not at the end/);
  });

  it("rejects non-PE input", () => {
    assert.throws(() => stripAuthenticode(Buffer.alloc(256)), /not a PE file/);
  });
});
