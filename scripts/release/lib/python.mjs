// The embeddable Python: extracts the zip into `python/<name>` entries and adds the backend to its ._pth.
import { readZip } from "@abfc/env";

/** zipBuf = the python-<v>-embed-amd64.zip; returns Map<"python/<name>", Buffer>. */
export function embedPythonFiles(zipBuf) {
  const out = new Map();
  for (const e of readZip(zipBuf)) out.set(`python/${e.name}`, e.read());
  const pths = [...out.keys()].filter((k) => /^python\/[^/]*$/.test(k) && /^python\/python3.*\._pth$/.test(k));
  if (pths.length !== 1) throw new Error(`expected exactly one python3*._pth at the top level, found ${pths.length}`);
  for (const need of ["python/python.exe", "python/LICENSE.txt"]) {
    if (!out.has(need)) throw new Error(`embeddable Python zip has no ${need.slice("python/".length)}`);
  }
  const pth = out.get(pths[0]);
  const text = pth.toString("utf8");
  const sep = text.length === 0 || text.endsWith("\n") ? "" : "\r\n";
  out.set(pths[0], Buffer.from(`${text}${sep}..\\backend\r\n`, "utf8"));
  return out;
}
