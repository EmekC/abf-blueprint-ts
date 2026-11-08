// A minimal ustar reader for the npm tarballs the release scan opens (design 18.10).
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

function cString(buf, from, to) {
  const end = buf.indexOf(0, from);
  return buf.toString("utf8", from, end >= 0 && end < to ? end : to);
}

function octal(buf, from, to, what) {
  if ((buf[from] & 0x80) !== 0) throw new Error(`tar: base-256 ${what} is not supported`);
  const text = buf.toString("latin1", from, to).replace(/[\0 ]+$/, "").replace(/^ +/, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar: bad ${what} field`);
  return parseInt(text, 8);
}

function isZeroBlock(buf, at) {
  for (let i = at; i < at + BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

/** Parses the `path=` record of a pax extended header. */
function paxPath(data) {
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    if (sp < 0) break;
    const len = parseInt(data.toString("latin1", p, sp), 10);
    if (!(len > 0) || p + len > data.length) break;
    const rec = data.toString("utf8", sp + 1, p + len - 1);
    const eq = rec.indexOf("=");
    if (eq > 0 && rec.slice(0, eq) === "path") return rec.slice(eq + 1);
    p += len;
  }
  return null;
}

/**
 * Reads a gzip-compressed ustar archive. Returns the regular files as `{name, data}` (name = prefix + "/" + name when a
 * ustar prefix is set; pax `path` and GNU long names are honored). Stops at two zero blocks.
 */
export function readTgz(buf) {
  const tar = gunzipSync(buf);
  const out = [];
  let at = 0;
  let longName = null;
  while (at + BLOCK <= tar.length) {
    if (isZeroBlock(tar, at)) {
      if (at + 2 * BLOCK <= tar.length && isZeroBlock(tar, at + BLOCK)) break;
      if (at + 2 * BLOCK > tar.length) break;
      at += BLOCK;
      continue;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[at + i];
    if (sum !== octal(tar, at + 148, at + 156, "checksum")) throw new Error("tar: bad header checksum");
    const size = octal(tar, at + 124, at + 136, "size");
    const type = String.fromCharCode(tar[at + 156]);
    let name = cString(tar, at, at + 100);
    if (tar.toString("latin1", at + 257, at + 262) === "ustar") {
      const prefix = cString(tar, at + 345, at + 500);
      if (prefix !== "") name = `${prefix}/${name}`;
    }
    const dataAt = at + BLOCK;
    if (dataAt + size > tar.length) throw new Error(`tar: entry "${name}" is truncated`);
    const data = tar.subarray(dataAt, dataAt + size);
    at = dataAt + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      longName = paxPath(data) ?? longName;
    } else if (type === "L") {
      longName = cString(data, 0, data.length);
    } else if (type === "g") {
      // global pax header: no file
    } else if (type === "0" || type === "\0") {
      out.push({ name: longName ?? name, data: Buffer.from(data) });
      longName = null;
    } else {
      longName = null;
    }
  }
  return out;
}
