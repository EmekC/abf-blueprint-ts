// `.abfc/tsconfig.paths.json`: maps UE package paths to the generated stubs (machine-specific, gitignored).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fwd = (p: string): string => p.replaceAll("\\", "/");

/** Returns the written file. `runtimeDts` and `testkitDts` are the absolute paths of the packages' `index.d.ts`. */
export function writeTsconfigPaths(abfcDir: string, profileId: string, mod: string, runtimeDts: string, testkitDts: string): string {
  // The `.js` suffix makes the mapping resolve in ESM (nodenext) projects too; TS finds the sibling `.d.ts`.
  const base = `./stubs/${profileId}`;
  const doc = {
    compilerOptions: {
      paths: {
        "/Script/*": [`${base}/Script/*.js`],
        "/Game/*": [`${base}/Game/*.js`],
        [`/${mod}/*`]: [`${base}/Mod/${mod}/*.js`],
        "@abfc/runtime": [fwd(runtimeDts)],
        "@abfc/testkit": [fwd(testkitDts)],
      },
    },
  };
  mkdirSync(abfcDir, { recursive: true });
  const file = join(abfcDir, "tsconfig.paths.json");
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return file;
}
