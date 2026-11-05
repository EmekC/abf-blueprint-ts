import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Deletes `dir` and writes every file (relative path -> text) below it. */
export function writeStubs(dir: string, files: Map<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [rel, text] of files) {
    const target = join(dir, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
}
