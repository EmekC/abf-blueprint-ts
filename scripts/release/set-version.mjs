#!/usr/bin/env node
// Lockstep version for all workspace packages (design 18.10).
//
//   node scripts/release/set-version.mjs <semver>          set the version everywhere
//   node scripts/release/set-version.mjs --check <semver>  exit 1 and list mismatches
//   node scripts/release/set-version.mjs --print           print the version of packages/cli
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SEMVER, applyVersion, checkVersions } from "./lib/versions.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const USAGE = "usage: node scripts/release/set-version.mjs <semver> | --check <semver> | --print";

function fail(message) {
  console.error(`set-version: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--print") {
  console.log(JSON.parse(readFileSync(join(repoRoot, "packages", "cli", "package.json"), "utf8")).version);
} else if (argv.length === 2 && argv[0] === "--check") {
  if (!SEMVER.test(argv[1])) fail(`${argv[1]} is not a semver like 1.0.0 or 1.0.0-rc.0\n${USAGE}`);
  const problems = checkVersions(repoRoot, argv[1]);
  if (problems.length > 0) {
    for (const p of problems) console.error(`mismatch: ${p}`);
    process.exit(1);
  }
  console.log(`all packages are at ${argv[1]}`);
} else if (argv.length === 1 && SEMVER.test(argv[0])) {
  const { changed } = applyVersion(repoRoot, argv[0], { write: true });
  for (const f of changed) console.log(`updated ${f}`);
  console.log(changed.length === 0 ? `already at ${argv[0]}` : `${changed.length} file(s) set to ${argv[0]}`);
} else {
  fail(`expected a semver, --check <semver> or --print\n${USAGE}`);
}
