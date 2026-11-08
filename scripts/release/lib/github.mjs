// Pure helpers for staging the GitHub release files (design 18.10).

const SEMVER = /^(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?$/;

function sectionBody(lines, heading) {
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## [")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

// The body under `## [<version>]` of a Keep a Changelog file, up to the next `## [`. A prerelease version falls back to
// the section of its major.minor.patch. Throws when neither section exists.
export function changelogSection(text, version) {
  const m = SEMVER.exec(version);
  if (m === null) throw new Error(`not a semver version: ${version}`);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const candidates = [`## [${version}]`];
  if (m[2] !== undefined) candidates.push(`## [${m[1]}]`);
  for (const heading of candidates) {
    const body = sectionBody(lines, heading);
    if (body !== null) return body;
  }
  throw new Error(`CHANGELOG has no section for ${candidates.map((c) => `"${c}"`).join(" or ")}`);
}

// `<sha256>  <name>` lines (two spaces, the sha256sum text format), sorted by name.
export function sumsText(files) {
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => `${f.sha256}  ${f.name}\n`)
    .join("");
}
