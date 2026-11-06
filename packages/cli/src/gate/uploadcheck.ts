// Gate 6 of `abfc publish`: the file rules of the backend's check_upload, applied read-only to a mod folder.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "@abfc/ir";

/** One file below a mod folder: path relative to it with `/` separators, and its size in bytes. */
export interface FolderFile {
  rel: string;
  size: number;
}

/** Lists every file below `root` (read-only). A folder that does not exist has no files. */
export function walkFolder(root: string): FolderFile[] {
  const out: FolderFile[] = [];
  if (!existsSync(root)) return out;
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const full = join(dir, n);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full, `${prefix}${n}/`);
      else if (s.isFile()) out.push({ rel: `${prefix}${n}`, size: s.size });
    }
  };
  walk(root, "");
  return out;
}

/** File types the official templates contain; any other type ships inside the mod zip too. */
const SHIPPABLE = new Set([".uasset", ".umap", ".uexp", ".ubulk", ".uplugin", ".abfmod", ".ini", ".png"]);
/** Editor working folders: zipped and uploaded with the mod. */
const WORKING_FOLDERS = new Set(["Saved", "Intermediate", "Binaries", "DerivedDataCache"]);

const extOf = (rel: string): string => {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i).toLowerCase();
};

/**
 * Applies the file rules of check_upload to `files` of the folder called `label` ("mod" or "stage"):
 * `.md` is an error (mod.io rejects it, ABFC7010); other unknown file types and editor working folders are warnings (ABFC7012).
 * The `/Game` reference check of check_upload needs the retail asset list and stays with the backend tool.
 */
export function uploadFileDiagnostics(label: string, files: FolderFile[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    const top = f.rel.split("/")[0] ?? "";
    if (f.rel.includes("/") && WORKING_FOLDERS.has(top)) {
      out.push({
        severity: "warning",
        code: "ABFC7012",
        message: `${label} folder: ${f.rel} is in an editor working folder; it is zipped and uploaded too.`,
      });
      continue;
    }
    const ext = extOf(f.rel);
    if (ext === ".md") {
      out.push({
        severity: "error",
        code: "ABFC7010",
        message: `${label} folder: ${f.rel}: mod.io rejects .md files (error 29200, shown as "Unknown ApiError").`,
        fix: "move the file out of the mod folder.",
      });
    } else if (!SHIPPABLE.has(ext)) {
      out.push({
        severity: "warning",
        code: "ABFC7012",
        message: `${label} folder: ${f.rel} is not a file type the templates contain; it would ship inside the mod zip.`,
      });
    }
  }
  return out;
}
