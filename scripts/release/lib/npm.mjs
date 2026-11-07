// Pure helpers of the npm release (design 18.10): publish order, packed-file allowlist and manifest checks.
import { selectAllowed } from "./allowlist.mjs";

/**
 * Topological order over the packages' dependencies on each other (Kahn); ties by name.
 * `deps` may name packages outside the list (ignored). Throws on a cycle.
 */
export function publishOrder(pkgs) {
  const names = new Set(pkgs.map((p) => p.name));
  const pending = new Map(pkgs.map((p) => [p.name, new Set(p.deps.filter((d) => names.has(d) && d !== p.name))]));
  const order = [];
  while (pending.size > 0) {
    const ready = [...pending.entries()].filter(([, deps]) => deps.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) throw new Error(`dependency cycle among: ${[...pending.keys()].sort().join(", ")}`);
    const next = ready[0];
    order.push(next);
    pending.delete(next);
    for (const deps of pending.values()) deps.delete(next);
  }
  return order;
}

/** Problems of the files `npm pack` would put in the tarball of `name`: files off the allowlist and patterns matching nothing. */
export function checkPackFiles(name, paths, patterns) {
  const sel = selectAllowed(paths, patterns);
  const problems = [];
  for (const p of sel.rejected) problems.push(`${name}: ${p} is in the tarball but not on the npm allowlist`);
  for (const p of sel.unmatchedPatterns) problems.push(`${name}: allowlist entry ${p} matches no packed file`);
  return problems;
}

/** Problems of a package.json that is about to be published at `version`. */
export function checkManifest(json, version) {
  const name = typeof json.name === "string" ? json.name : "(unnamed package)";
  const problems = [];
  if (json.private === true) problems.push(`${name}: is private`);
  if (json.version !== version) problems.push(`${name}: version is ${json.version}, expected ${version}`);
  if (typeof json.repository?.directory !== "string" || json.repository.directory === "") problems.push(`${name}: repository.directory is not set`);
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dep, range] of Object.entries(json[key] ?? {})) {
      const r = String(range);
      if (/^(file|link|workspace):/.test(r)) problems.push(`${name}: ${key}.${dep} is ${r} (local reference)`);
      if (dep.startsWith("@abfc/") && r !== version) problems.push(`${name}: ${key}.${dep} is ${r}, expected ${version}`);
    }
  }
  return problems;
}
