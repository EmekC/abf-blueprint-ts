// Import scan for the vendored backend: every local module that a vendored .py imports must be vendored too.
// A module is "local" when the backend repository has it as `<name>.py` or `<name>/__init__.py` next to the importing
// file, in one of its parent folders, or at the repository root. Stdlib and third-party modules are never in the repository,
// so they are ignored. Lazy imports inside functions are found as well (any line that starts with import / from).

/** Dotted names imported by the source: [{ module, names, level }]; `level` is the number of leading dots of a relative import. */
export function parseImports(source) {
  const out = [];
  // join backslash continuations and parenthesised name lists onto one line
  const text = source
    .replace(/\r\n?/g, "\n")
    .replace(/#[^\n]*/g, "")
    .replace(/\\\n/g, " ")
    .replace(/^(\s*from\s+[^\n(]*\bimport\s*)\(([^)]*)\)/gm, (_m, head, inner) => `${head}${inner.replace(/\n/g, " ")}`);
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    let m = /^\s*import\s+(.+)$/.exec(line);
    if (m !== null) {
      for (const part of m[1].split(",")) {
        const mod = /^\s*([A-Za-z_][\w.]*)/.exec(part);
        if (mod !== null) out.push({ module: mod[1], names: [], level: 0 });
      }
      continue;
    }
    m = /^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+(.+)$/.exec(line);
    if (m !== null) {
      const names = m[3]
        .replace(/[()]/g, " ")
        .split(",")
        .map((s) => /^\s*([A-Za-z_]\w*)/.exec(s))
        .filter((x) => x !== null)
        .map((x) => x[1]);
      out.push({ module: m[2] ?? "", names, level: m[1].length });
    }
  }
  return out;
}

/** Repository files (from `allNames`) a `dotted` module name resolves to when imported from `fromDir`; [] when it is not local. */
function resolveModule(dotted, baseDirs, nameSet) {
  const parts = dotted === "" ? [] : dotted.split(".");
  for (const base of baseDirs) {
    const hits = [];
    let dir = base;
    for (let i = 0; i < parts.length; i++) {
      const stem = dir === "" ? parts[i] : `${dir}/${parts[i]}`;
      if (nameSet.has(`${stem}.py`)) {
        hits.push(`${stem}.py`);
        break;
      }
      if (nameSet.has(`${stem}/__init__.py`)) {
        hits.push(`${stem}/__init__.py`);
        dir = stem;
        continue;
      }
      break;
    }
    if (hits.length > 0) return { hits, dir };
    if (parts.length === 0 && nameSet.has(`${base === "" ? "" : `${base}/`}__init__.py`)) return { hits: [], dir: base };
  }
  return { hits: [], dir: null };
}

/**
 * `vendored`: Map<path, Buffer> of the vendored files; `allNames`: every file path of the backend commit.
 * Returns the repository files imported by vendored .py files that are not vendored: [{ file, imports, missing }], sorted.
 */
export function findMissingLocalImports(vendored, allNames) {
  const nameSet = new Set(allNames);
  const missing = new Map();
  for (const [file, data] of vendored) {
    if (!file.endsWith(".py")) continue;
    const slash = file.lastIndexOf("/");
    const fileDir = slash < 0 ? "" : file.slice(0, slash);
    // the importing folder, each parent folder and the root (editor scripts run with their own folder on sys.path)
    const parents = [];
    for (let d = fileDir; ; d = d.slice(0, Math.max(0, d.lastIndexOf("/")))) {
      parents.push(d);
      if (d === "") break;
    }
    for (const imp of parseImports(Buffer.from(data).toString("utf8"))) {
      let baseDirs = parents;
      if (imp.level > 0) {
        let d = fileDir;
        for (let i = 1; i < imp.level; i++) d = d.slice(0, Math.max(0, d.lastIndexOf("/")));
        baseDirs = [d];
      }
      const r = resolveModule(imp.module, baseDirs, nameSet);
      const needed = [...r.hits];
      if (r.dir !== null && imp.names.length > 0 && (imp.level > 0 || imp.module !== "" || r.hits.length > 0)) {
        // `from pkg import sub`: sub may be a submodule of a local package
        const pkgHit = r.hits.length === 0 || r.hits[r.hits.length - 1].endsWith("/__init__.py");
        if (pkgHit) {
          for (const n of imp.names) {
            const stem = r.dir === "" ? n : `${r.dir}/${n}`;
            if (nameSet.has(`${stem}.py`)) needed.push(`${stem}.py`);
            else if (nameSet.has(`${stem}/__init__.py`)) needed.push(`${stem}/__init__.py`);
          }
        }
      }
      for (const dep of needed) {
        if (vendored.has(dep)) continue;
        const key = `${file}\t${dep}`;
        if (!missing.has(key)) missing.set(key, { file, imports: imp.module === "" ? imp.names.join(", ") : imp.module, missing: dep });
      }
    }
  }
  return [...missing.values()].sort((a, b) => (a.file + a.missing < b.file + b.missing ? -1 : 1));
}

/** Throws with one line per gap. */
export function assertNoMissingLocalImports(vendored, allNames) {
  const gaps = findMissingLocalImports(vendored, allNames);
  if (gaps.length > 0) {
    throw new Error(
      `vendored backend files import modules that the allowlist leaves out (add them to release/allowlist.json "backend"): ${gaps
        .map((g) => `${g.file} imports ${g.imports} -> ${g.missing}`)
        .join("; ")}`,
    );
  }
}
