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
  const names = readdirSync(dir);
  const file = names.find((n) => /^(licen[cs]e|copying)([.-].*)?$/i.test(n));
  const license = licenseOf(pkg);
  if (file !== undefined) return { name: pkg.name, version: pkg.version, license, text: readFileSync(join(dir, file), "utf8") };
  // No license file: some packages carry the text in a "License" section of their README; for MIT packages that only name
  // the license, the standard MIT text is generated from the README's copyright line or the package author.
  const readmeName = names.find((n) => /^readme(\..*)?$/i.test(n));
  const readme = readmeName === undefined ? "" : readFileSync(join(dir, readmeName), "utf8");
  const section = licenseSectionOf(readme);
  if (section !== null) return { name: pkg.name, version: pkg.version, license, text: section };
  if (license === "MIT") {
    const line = /^[ \t>*]*(Copyright[^\r\n]*)$/im.exec(readme);
    const author = typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? "");
    const holder = line !== null ? line[1].trim() : author !== "" ? `Copyright (c) ${author.replace(/\s*[<(].*$/, "")}` : "";
    if (holder !== "") return { name: pkg.name, version: pkg.version, license, text: mitText(holder) };
  }
  throw new Error(`package ${pkg.name} (${dir}) has no license file`);
}

/** The body of a README's License section (ATX heading to the next heading, or an underlined heading to the end), or null when it is too short to be a license text. */
function licenseSectionOf(readme) {
  const atx = /^#{1,6}[ \t]+licen[cs]e[ \t]*$/im.exec(readme);
  let body = null;
  if (atx !== null) {
    const rest = readme.slice(atx.index + atx[0].length);
    const next = /^#{1,6}[ \t]/m.exec(rest);
    body = next === null ? rest : rest.slice(0, next.index);
  } else {
    const setext = /^licen[cs]e[^\r\n]*\r?\n[-=]{3,}[ \t]*\r?\n/im.exec(readme);
    if (setext !== null) body = readme.slice(setext.index + setext[0].length);
  }
  const text = body === null ? "" : body.trim();
  return text.length >= 300 ? text : null;
}

function mitText(copyrightLine) {
  return [
    "MIT License (text generated from the package metadata: the package ships no license file)",
    "",
    copyrightLine,
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the \"Software\"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
    "",
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
  ].join("\n");
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
