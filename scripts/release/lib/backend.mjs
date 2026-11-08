// Vendors the pinned backend from a local git checkout. Read-only git only (rev-parse, ls-tree, cat-file).
import { spawnSync } from "node:child_process";
import { selectAllowed } from "./allowlist.mjs";
import { sha256Buf } from "./pins.mjs";
import { assertNoMissingLocalImports } from "./pyimports.mjs";

function git(repoDir, args, asBuffer) {
  const r = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: asBuffer ? "buffer" : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw new Error(`git ${args[0]} failed: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${r.status}): ${String(r.stderr).trim()}`);
  }
  return r.stdout;
}

/** sha256 over the sorted `${path}\t${sha256(blob)}\n` lines of the files. */
export function filesSha256Of(files) {
  const lines = [...files.keys()].sort().map((p) => `${p}\t${sha256Buf(files.get(p))}\n`);
  return sha256Buf(Buffer.from(lines.join(""), "utf8"));
}

/**
 * Reads the allowlisted files of `commit` from `repoDir`; returns { files: Map<path, Buffer>, filesSha256 }.
 * Throws when a vendored .py imports a local module of the backend repository that the allowlist leaves out.
 */
export function vendorBackend({ repoDir, commit, version, patterns }) {
  const resolved = String(git(repoDir, ["rev-parse", "--verify", `${commit}^{commit}`], false)).trim();
  if (resolved !== commit) throw new Error(`backend commit mismatch: asked ${commit}, git resolved ${resolved}`);
  const names = String(git(repoDir, ["ls-tree", "-r", "-z", "--name-only", commit], false))
    .split("\0")
    .filter((n) => n !== "");
  const sel = selectAllowed(names, patterns);
  if (sel.unmatchedPatterns.length > 0) {
    throw new Error(`backend allowlist patterns matched nothing in ${commit}: ${sel.unmatchedPatterns.join(", ")}`);
  }
  const files = new Map();
  for (const path of [...sel.selected].sort()) {
    files.set(path, git(repoDir, ["cat-file", "blob", `${commit}:${path}`], true));
  }
  assertNoMissingLocalImports(files, names);
  const server = files.get("server.py");
  if (server === undefined) throw new Error("backend has no server.py");
  const m = /^SERVER_VERSION = "([^"]+)"/m.exec(server.toString("utf8"));
  if (m === null) throw new Error("server.py has no SERVER_VERSION line");
  if (m[1] !== version) throw new Error(`backend SERVER_VERSION is ${m[1]}, pinned version is ${version}`);
  return { files, filesSha256: filesSha256Of(files) };
}
