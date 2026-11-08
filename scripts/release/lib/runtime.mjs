// Collects the files of runtime.zip (design 18.8) and builds the zip plus its sha256 manifest.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { writeZip } from "@abfc/env";
import { sha256Buf } from "./pins.mjs";

const TEXT_EXT = /\.(py|json|ts|txt|md|cjs|iss)$/i;
const USER_PATH = /[A-Za-z]:[\\/]Users[\\/](?!Public[\\/])[^\\/\s"']+/i;

function listFiles(dir, re) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && re.test(d.name))
    .map((d) => d.name)
    .sort();
}

/** Declaration files of a package's dist/src with a trailing sourceMappingURL comment removed. */
function declarationText(file) {
  const text = readFileSync(file, "utf8");
  return Buffer.from(text.replace(/(\r?\n)?\/\/# sourceMappingURL=[^\r\n]*\s*$/, "\n"), "utf8");
}

/** Throws when a shipped text file contains a Windows user-profile path (other than Public). */
export function checkNoUserPaths(name, buf) {
  if (!TEXT_EXT.test(name)) return;
  const m = USER_PATH.exec(buf.toString("utf8"));
  if (m !== null) throw new Error(`${name}: contains a user path (${m[0]})`);
}

const CLAUDE_DIR = /\.claude[\\/]/i;

/**
 * Throws when a binary file (any extension) holds a Windows user-profile path or a `.claude` folder path as latin1 or
 * UTF-16LE text (both byte alignments). Catches build paths that a Node SEA blob or a PE file embeds.
 */
export function checkNoBuildPathsInBinary(name, buf) {
  // 8 MB windows with an overlap (even sizes, so UTF-16 alignment is the same in every window): converting a 130 MB file to one string is slow and can exhaust memory.
  const WINDOW = 8 * 1024 * 1024;
  const OVERLAP = 4096;
  // UTF-16 is decoded from an aligned, even-length scratch copy: decoding an odd-offset or odd-length Buffer view with toString("utf16le") crashes Node (heap corruption).
  const scratch = Buffer.alloc(Math.min(buf.length, WINDOW + OVERLAP) + 2);
  const test = (enc, text) => {
    const m = USER_PATH.exec(text) ?? CLAUDE_DIR.exec(text);
    if (m !== null) throw new Error(`${name}: contains a build path as ${enc} text (${m[0]})`);
  };
  for (let start = 0; start < buf.length; start += WINDOW) {
    const end = Math.min(buf.length, start + WINDOW + OVERLAP);
    test("latin1", buf.toString("latin1", start, end));
    for (const skip of [0, 1]) {
      const n = (end - start - skip) & ~1;
      if (n <= 0) continue;
      buf.copy(scratch, 0, start + skip, start + skip + n);
      test("utf16le", scratch.toString("utf16le", 0, n));
    }
  }
}

/**
 * Returns Map<runtime path, Buffer>. `backendFiles` = Map<path, Buffer> (without prefix), `pythonFiles` = Map with the
 * `python/` prefix already, `notices` = the THIRD-PARTY-NOTICES text.
 */
export function collectRuntimeFiles({ repoRoot, backendFiles, pythonFiles, notices }) {
  const out = new Map();
  for (const [p, b] of backendFiles) out.set(`backend/${p}`, b);
  for (const [p, b] of pythonFiles) out.set(p, b);

  const profiles = join(repoRoot, "packages", "env", "profiles");
  for (const n of listFiles(profiles, /\.json$/)) out.set(`profiles/${n}`, readFileSync(join(profiles, n)));

  out.set("data/descriptions.json", readFileSync(join(repoRoot, "packages", "stubgen", "data", "descriptions.json")));

  for (const [pkg, dest] of [
    ["runtime", "runtime"],
    ["testkit", "testkit"],
    ["ir", "ir"],
  ]) {
    const dir = join(repoRoot, "packages", pkg, "dist", "src");
    for (const n of listFiles(dir, /\.d\.ts$/)) out.set(`types/${dest}/${n}`, declarationText(join(dir, n)));
  }

  const tsLib = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "lib");
  for (const n of listFiles(tsLib, /^lib.*\.d\.ts$/)) out.set(`tslib/${n}`, readFileSync(join(tsLib, n)));

  out.set("schema/abf.config.schema.json", readFileSync(join(repoRoot, "packages", "cli", "schema", "abf.config.schema.json")));
  out.set("THIRD-PARTY-NOTICES.txt", Buffer.isBuffer(notices) ? notices : Buffer.from(notices, "utf8"));
  return out;
}

/** Deterministic runtime.zip (entries sorted by name) and its RuntimeManifest. */
export function buildRuntimeZip(files, abfcVersion) {
  const names = [...files.keys()].sort();
  const zip = writeZip(names.map((name) => ({ name, data: files.get(name) })));
  const manifestFiles = {};
  for (const name of names) {
    const data = files.get(name);
    manifestFiles[name] = { size: data.length, sha256: sha256Buf(data) };
  }
  return { zip, manifest: { schemaVersion: 1, abfcVersion, zipSha256: sha256Buf(zip), files: manifestFiles } };
}
