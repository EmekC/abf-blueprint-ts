// Paths and file URIs. Editors send `file:///c%3A/...` with any drive-letter case; every map in the server is keyed by `pathKey`.
import { resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The file path of a `file:` URI; null for any other scheme or an unparsable URI. */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file:")) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Normalised absolute path used as a map key (lower-case on Windows, where file names are case-insensitive). */
export function pathKey(p: string): string {
  return process.platform === "win32" ? win32.resolve(p).toLowerCase() : resolve(p);
}

export function pathToUri(p: string): string {
  return pathToFileURL(p).href;
}

/** Whether `path` is `dir` or lies below it. */
export function isUnder(path: string, dir: string): boolean {
  const k = pathKey(path);
  const d = pathKey(dir);
  if (k === d) return true;
  const sep = process.platform === "win32" ? "\\" : "/";
  return k.startsWith(d.endsWith(sep) ? d : d + sep);
}
