// THIRD-PARTY-NOTICES.txt from an esbuild metafile plus extra components (Node, Python, backend).
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Sorted unique package directories (absolute) of node_modules inputs; the deepest node_modules segment wins. */
export function packageDirsFromMetafile(metafile, repoRoot) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const norm = input.replaceAll("\\", "/");
    const idx = norm.lastIndexOf("node_modules/");
    if (idx < 0) continue;
    const rest = norm.slice(idx + "node_modules/".length).split("/");
    const nameParts = rest[0].startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
    if (nameParts.length === 0 || nameParts.some((p) => p === "")) continue;
    const base = norm.slice(0, idx + "node_modules/".length);
    dirs.add(resolve(repoRoot, base, ...nameParts));
  }
  return [...dirs].sort();
}

function licenseOf(pkgJson) {
  const l = pkgJson.license;
  if (typeof l === "string") return l;
  if (l !== undefined && l !== null && typeof l.type === "string") return l.type;
  if (Array.isArray(pkgJson.licenses)) return pkgJson.licenses.map((x) => x.type).join(" OR ");
  return "UNKNOWN";
}

/** Reads name, version, license and license text of a package directory (throws when it has no license file). */
export function readPackageNotice(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\..*)?$/i.test(n));
  if (file === undefined) throw new Error(`package ${pkg.name} (${dir}) has no license file`);
  return { name: pkg.name, version: pkg.version, license: licenseOf(pkg), text: readFileSync(join(dir, file), "utf8") };
}

/** `packages` = absolute dirs (from packageDirsFromMetafile); `extras` = [{ name, version, license, text }]. */
export function noticesText({ packages, extras }) {
  const items = [...extras, ...packages.map((d) => readPackageNotice(d))];
  const parts = ["abfc third-party notices", ""];
  for (const it of items) {
    parts.push(`== ${it.name} ${it.version} (${it.license}) ==`, "", it.text.replace(/\s+$/, ""), "");
  }
  return `${parts.join("\n")}\n`;
}
