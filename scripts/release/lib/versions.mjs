// Lockstep versioning of the workspace packages (design 18.10): package.json files, intra-@abfc dependency ranges,
// package-lock workspace entries and packages/cli/src/version.ts.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const DEP_KEYS = ["dependencies", "devDependencies", "peerDependencies"];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function jsonText(json) {
  return `${JSON.stringify(json, null, 2)}\n`;
}

function versionTs(version) {
  return `/** The abfc version. Kept equal to the version of \`packages/cli/package.json\` by \`scripts/release/set-version.mjs\` and a test. */\nexport const ABFC_VERSION = "${version}";\n`;
}

function backendVersionTs(version) {
  return `/** The version reported as the MCP client version. Kept equal to the version of \`packages/backend/package.json\` by \`scripts/release/set-version.mjs\`. */\nexport const CLIENT_VERSION = "${version}";\n`;
}

/** Every workspace package: `[{dir, file, json}]`, sorted by directory name. */
export function readWorkspace(repoRoot) {
  const out = [];
  const root = join(repoRoot, "packages");
  for (const dir of readdirSync(root).sort()) {
    const file = join(root, dir, "package.json");
    if (existsSync(file)) out.push({ dir, file, json: readJson(file) });
  }
  return out;
}

/** The directory names of the public (non-private) packages. */
export function publicDirs(repoRoot) {
  return readWorkspace(repoRoot)
    .filter((p) => p.json.private !== true)
    .map((p) => p.dir);
}

/** The package.json after `version` and every `@abfc/*` dependency value were set; the input object is not changed. */
function withVersion(json, version) {
  const next = structuredClone(json);
  next.version = version;
  for (const key of DEP_KEYS) {
    const deps = next[key];
    if (deps === undefined) continue;
    for (const name of Object.keys(deps)) if (name.startsWith("@abfc/")) deps[name] = version;
  }
  return next;
}

/**
 * Sets `version` everywhere. With `write: false` only reports. Returns `{changed}`: repo-relative files that differ.
 */
export function applyVersion(repoRoot, version, { write }) {
  const changed = [];
  const put = (rel, text) => {
    const file = join(repoRoot, rel);
    const before = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (before === text) return;
    changed.push(rel);
    if (write) writeFileSync(file, text);
  };

  for (const p of readWorkspace(repoRoot)) {
    put(`packages/${p.dir}/package.json`, jsonText(withVersion(p.json, version)));
  }

  const cliTs = "packages/cli/src/version.ts";
  if (existsSync(join(repoRoot, cliTs))) put(cliTs, versionTs(version));

  const backendTs = "packages/backend/src/version.ts";
  if (existsSync(join(repoRoot, backendTs))) put(backendTs, backendVersionTs(version));

  const lockRel = "package-lock.json";
  const lockFile = join(repoRoot, lockRel);
  if (existsSync(lockFile)) {
    const lock = readJson(lockFile);
    for (const p of readWorkspace(repoRoot)) {
      const entry = lock.packages?.[`packages/${p.dir}`];
      if (entry === undefined) continue;
      entry.version = version;
      for (const key of DEP_KEYS) {
        const deps = entry[key];
        if (deps === undefined) continue;
        for (const name of Object.keys(deps)) if (name.startsWith("@abfc/")) deps[name] = version;
      }
    }
    put(lockRel, jsonText(lock));
  }
  return { changed };
}

/** Mismatches between the repository and `version` (empty when in lockstep). */
export function checkVersions(repoRoot, version) {
  const problems = [];
  const workspace = readWorkspace(repoRoot);
  for (const p of workspace) {
    const rel = `packages/${p.dir}/package.json`;
    if (p.json.version !== version) problems.push(`${rel}: version is ${p.json.version}, expected ${version}`);
    for (const key of DEP_KEYS) {
      for (const [name, range] of Object.entries(p.json[key] ?? {})) {
        if (name.startsWith("@abfc/") && range !== version) problems.push(`${rel}: ${key}.${name} is ${range}, expected ${version}`);
      }
    }
  }
  const cliTs = join(repoRoot, "packages", "cli", "src", "version.ts");
  if (existsSync(cliTs)) {
    const m = /ABFC_VERSION\s*=\s*"([^"]*)"/.exec(readFileSync(cliTs, "utf8"));
    if (m === null) problems.push("packages/cli/src/version.ts: ABFC_VERSION not found");
    else if (m[1] !== version) problems.push(`packages/cli/src/version.ts: ABFC_VERSION is ${m[1]}, expected ${version}`);
  }
  const backendTs = join(repoRoot, "packages", "backend", "src", "version.ts");
  if (existsSync(backendTs)) {
    const m = /CLIENT_VERSION\s*=\s*"([^"]*)"/.exec(readFileSync(backendTs, "utf8"));
    if (m === null) problems.push("packages/backend/src/version.ts: CLIENT_VERSION not found");
    else if (m[1] !== version) problems.push(`packages/backend/src/version.ts: CLIENT_VERSION is ${m[1]}, expected ${version}`);
  }
  const lockFile = join(repoRoot, "package-lock.json");
  if (existsSync(lockFile)) {
    const lock = readJson(lockFile);
    for (const p of workspace) {
      const entry = lock.packages?.[`packages/${p.dir}`];
      if (entry === undefined) {
        problems.push(`package-lock.json: no entry for packages/${p.dir}`);
        continue;
      }
      if (entry.version !== version) problems.push(`package-lock.json: packages/${p.dir} version is ${entry.version}, expected ${version}`);
      for (const key of DEP_KEYS) {
        for (const [name, range] of Object.entries(entry[key] ?? {})) {
          if (name.startsWith("@abfc/") && range !== version) problems.push(`package-lock.json: packages/${p.dir} ${key}.${name} is ${range}, expected ${version}`);
        }
      }
    }
  }
  return problems;
}
