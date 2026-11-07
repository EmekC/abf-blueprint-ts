// Removes the Authenticode certificate table of a PE file (same effect as `signtool remove /s`).
// The official Node signature does not match the SEA output any more; abfc.exe is left unsigned.

/** Returns { buf, removed }. Throws when the certificate table is not at the end of the file. */
export function stripAuthenticode(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error("not a PE file");
  const pe = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(pe) !== 0x4550) throw new Error("no PE signature");
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const ddStart = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
  if (ddStart < 0) throw new Error("unknown optional header");
  const count = buf.readUInt32LE(ddStart - 4); // NumberOfRvaAndSizes
  if (count <= 4) return { buf, removed: false };
  const sec = ddStart + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY (file offset, size)
  const off = buf.readUInt32LE(sec);
  const size = buf.readUInt32LE(sec + 4);
  if (off === 0 || size === 0) return { buf, removed: false };
  const tail = buf.subarray(off + size);
  if (off + size > buf.length || tail.length > 7 || tail.some((b) => b !== 0)) {
    throw new Error("certificate table is not at the end of the file");
  }
  const out = Buffer.from(buf.subarray(0, off));
  out.writeUInt32LE(0, sec);
  out.writeUInt32LE(0, sec + 4);
  return { buf: out, removed: true };
}
