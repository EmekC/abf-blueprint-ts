// Builds search-index.json, the data of the docs search dialog (website/src/components/Search.astro, matcher in fuzzy.mjs).
// No npm imports.

/** GitHub's heading anchor: lowercase, only letters, digits, spaces, `-` and `_` kept, spaces to `-`. */
export function headingSlug(heading) {
  return heading
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/** Links reduced to their text, code and emphasis markers dropped. */
function plain(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first non-empty prose line after line `from`, up to the next heading or fence (empty when there is none). */
function firstProseLine(lines, from) {
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#|```|~~~)/.test(line)) return "";
    if (line.trim() !== "") return plain(line);
  }
  return "";
}

/**
 * `{ version: 1, entries }` for the search dialog. `nodes` come from buildNodes, `runtimeMd` is docs/runtime.md, `errorsMd` is docs/errors.md,
 * `pages` is `[{ slug, title }]` and `base` the site's base path (`/abf-blueprint-ts`). Entries: `{ kind, title, tsName, qualified, url }` plus, for a node,
 * `module` (short name) and `text` / `doc: 1` (hand-written description, curated nodes only) and `blocked: 1` (blocked by the Blueprint filter) when set;
 * other kinds carry `text` (and no `module`).
 */
export function buildSearchIndex({ nodes, runtimeMd, errorsMd, pages, base }) {
  const entries = [];
  for (const n of nodes) {
    const entry = { kind: "node", title: n.title, tsName: n.tsName, qualified: n.qualified, url: `${base}/${n.slug}/`, module: n.moduleName };
    if (n.curated) {
      entry.text = n.text;
      entry.doc = 1;
    }
    if (n.blocked !== null) entry.blocked = 1;
    entries.push(entry);
  }
  const runtimeLines = runtimeMd.replace(/\r\n/g, "\n").split("\n");
  runtimeLines.forEach((line, i) => {
    const m = /^### `(@?[A-Za-z]+)`\s*$/.exec(line);
    if (m === null) return;
    entries.push({
      kind: "runtime",
      title: m[1],
      tsName: m[1].replace(/^@/, ""),
      qualified: "",
      text: firstProseLine(runtimeLines, i),
      url: `${base}/reference/runtime/#${headingSlug(`\`${m[1]}\``)}`,
    });
  });
  const errorLines = errorsMd.replace(/\r\n/g, "\n").split("\n");
  errorLines.forEach((line, i) => {
    const m = /^### (ABFC\d{4})\s*$/.exec(line);
    if (m === null) return;
    let text = "";
    for (let j = i + 1; j < errorLines.length && !errorLines[j].startsWith("### "); j++) {
      const meaning = /^Meaning:\s*(.*)$/.exec(errorLines[j]);
      if (meaning !== null) {
        text = plain(meaning[1]);
        break;
      }
    }
    entries.push({ kind: "error", title: m[1], tsName: "", qualified: "", text, url: `${base}/reference/errors/#${headingSlug(m[1])}` });
  });
  for (const p of pages) {
    entries.push({ kind: "page", title: p.title, tsName: "", qualified: "", text: "", url: `${base}/${p.slug}/` });
  }
  return { version: 1, entries };
}
