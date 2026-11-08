import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A small deterministic ZIP writer and a reader for the runtime archive that abfc.exe carries (design 18.8).
 * No zip64, no encryption, methods 0 (stored) and 8 (deflate) only.
 */

export interface ZipInput {
  name: string;
  data: Buffer;
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  method: 0 | 8;
  crc32: number;
  read(): Buffer;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const MAX_ENTRIES = 65534;
const MAX_U32 = 0xffffffff;

/** An entry name that cannot escape the extraction folder: relative, forward slashes, no drive, no `.`/`..`/empty segment. */
export function isSafeEntryName(n: string): boolean {
  if (n.length === 0) return false;
  if (n.includes("\\") || n.includes("\0")) return false;
  if (n.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(n)) return false;
  for (const seg of n.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

export function writeZip(entries: ZipInput[], opts?: { level?: number }): Buffer {
  const level = opts?.level ?? 9;
  if (entries.length > MAX_ENTRIES) throw new Error(`zip: too many entries (${entries.length})`);
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (!isSafeEntryName(e.name)) throw new Error(`zip: unsafe entry name "${e.name}"`);
    const key = e.name.toLowerCase();
    if (seen.has(key)) throw new Error(`zip: duplicate entry name "${e.name}"`);
    seen.add(key);
    if (e.data.length >= MAX_U32) throw new Error(`zip: entry "${e.name}" is too large`);
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    let method: 0 | 8 = 8;
    let body: Buffer = deflateRawSync(e.data, { level });
    if (body.length >= e.data.length) {
      method = 0;
      body = e.data;
    }
    if (offset >= MAX_U32 || offset + 30 + name.length + body.length >= MAX_U32) throw new Error("zip: archive is too large (no zip64)");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra length, comment length, disk number, internal and external attributes stay 0
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function readZip(buf: Buffer): ZipEntry[] {
  const eocdAt = findEocd(buf);
  if (eocdAt < 0) throw new Error("zip: end of central directory not found");
  const total = buf.readUInt16LE(eocdAt + 10);
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  const cdOffset = buf.readUInt32LE(eocdAt + 16);
  if (total === 0xffff || cdSize === MAX_U32 || cdOffset === MAX_U32) throw new Error("zip: zip64 archives are not supported");
  if (cdOffset + cdSize > eocdAt) throw new Error("zip: central directory is out of range");
  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("zip: bad central directory entry");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new Error("zip: bad central directory entry");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue; // directory entry
    if ((flags & FLAG_ENCRYPTED) !== 0) throw new Error(`zip: entry "${name}" is encrypted`);
    if (csize === MAX_U32 || size === MAX_U32 || localOffset === MAX_U32) throw new Error("zip: zip64 archives are not supported");
    if (method !== 0 && method !== 8) throw new Error(`zip: entry "${name}" uses unsupported method ${method}`);
    if (!isSafeEntryName(name)) throw new Error(`zip: unsafe entry name "${name}"`);
    if (seen.has(name)) throw new Error(`zip: duplicate entry name "${name}"`);
    seen.add(name);
    out.push({
      name,
      size,
      compressedSize: csize,
      method,
      crc32: crc,
      read: () => readEntry(buf, name, method, crc, csize, size, localOffset),
    });
  }
  return out;
}

function findEocd(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function readEntry(buf: Buffer, name: string, method: 0 | 8, crc: number, csize: number, size: number, localOffset: number): Buffer {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`zip: bad local header for "${name}"`);
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  if (start + csize > buf.length) throw new Error(`zip: data of "${name}" is out of range`);
  const raw = buf.subarray(start, start + csize);
  let data: Buffer;
  if (method === 0) {
    data = Buffer.from(raw);
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    } catch (e) {
      throw new Error(`zip: cannot inflate "${name}": ${(e as Error).message}`);
    }
  }
  if (data.length !== size) throw new Error(`zip: size mismatch for "${name}" (${data.length} != ${size})`);
  if ((crc32(data) >>> 0) !== crc) throw new Error(`zip: CRC mismatch for "${name}"`);
  return data;
}
