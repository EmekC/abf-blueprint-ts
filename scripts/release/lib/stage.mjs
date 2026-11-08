// Stages the files of the installer input folder / zip.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256Buf } from "./pins.mjs";

function toCrlf(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

/**
 * Clears `outDir` and writes: abfc.exe, the vsix (own file name), THIRD-PARTY-NOTICES.txt, LICENSE.txt (CRLF) and README.txt
 * (the template with `{version}` replaced, CRLF). `exe`, `vsix`, `notices`, `licenseFile`, `readmeTemplate` are file paths.
 * Returns the sorted file names.
 */
export function stageRelease({ exe, vsix, notices, licenseFile, readmeTemplate, version, outDir }) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(exe, join(outDir, "abfc.exe"));
  copyFileSync(vsix, join(outDir, basename(vsix)));
  copyFileSync(notices, join(outDir, "THIRD-PARTY-NOTICES.txt"));
  writeFileSync(join(outDir, "LICENSE.txt"), toCrlf(readFileSync(licenseFile, "utf8")));
  const readme = readFileSync(readmeTemplate, "utf8").replaceAll("{version}", version);
  writeFileSync(join(outDir, "README.txt"), toCrlf(readme));
  return readdirSync(outDir).sort();
}

/** [{ name, size, sha256 }] of the files in `dir`, sorted by name. */
export function listingOf(dir) {
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isFile())
    .sort()
    .map((name) => {
      const data = readFileSync(join(dir, name));
      return { name, size: data.length, sha256: sha256Buf(data) };
    });
}
