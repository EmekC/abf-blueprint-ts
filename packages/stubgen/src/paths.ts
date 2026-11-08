// `.abfc/tsconfig.paths.json`: maps UE package paths to the generated stubs (machine-specific, gitignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureTagsFile } from "./tags.js";

const fwd = (p: string): string => p.replaceAll("\\", "/");

/**
 * Returns the written file. `runtimeDts` and `testkitDts` are the absolute paths of the packages' `index.d.ts`;
 * `irDts` (abfc.exe only, where testkit's declarations import `@abfc/ir`) adds the `@abfc/ir` mapping.
 */
export function writeTsconfigPaths(abfcDir: string, profileId: string, mod: string, runtimeDts: string, testkitDts: string, irDts?: string): string {
  // The `.js` suffix makes the mapping resolve in ESM (nodenext) projects too; TS finds the sibling `.d.ts`.
  const base = `./stubs/${profileId}`;
  const doc = {
    // relative to this file; an extending tsconfig that has no `files` of its own inherits it (the generated tags, see tags.ts)
    files: ["./tags.d.ts"],
    compilerOptions: {
      paths: {
        "/Script/*": [`${base}/Script/*.js`],
        "/Game/*": [`${base}/Game/*.js`],
        [`/${mod}/*`]: [`${base}/Mod/${mod}/*.js`],
        "@mod/*": [`${base}/Mod/${mod}/*.js`],
        "@abfc/runtime": [fwd(runtimeDts)],
        "@abfc/testkit": [fwd(testkitDts)],
        ...(irDts === undefined ? {} : { "@abfc/ir": [fwd(irDts)] }),
      },
    },
  };
  mkdirSync(abfcDir, { recursive: true });
  ensureTagsFile(abfcDir); // `files` must never point at a missing file
  const file = join(abfcDir, "tsconfig.paths.json");
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return file;
}
