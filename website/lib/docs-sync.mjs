// Turns the repository's Markdown docs into pages of the Starlight site: the page list, link rewriting and front matter.
// No npm imports: node:path only, so the tests and the generator run without installing anything.
import { posix } from "node:path";

/**
 * The published pages in sidebar order. `src` is relative to the repository root, `slug` is the page path on the site (public contract:
 * released editor builds link to it), `title` overrides the first heading of the file.
 */
export const DOC_PAGES = [
  { src: "docs/getting-started.md", slug: "getting-started", title: "Getting started" },
  { src: "docs/install.md", slug: "guides/install" },
  { src: "docs/first-mod.md", slug: "guides/first-mod" },
  { src: "docs/troubleshooting.md", slug: "guides/troubleshooting" },
  { src: "docs/runtime.md", slug: "reference/runtime", title: "Runtime API" },
  { src: "docs/cli.md", slug: "reference/cli" },
  { src: "docs/config.md", slug: "reference/config" },
  { src: "docs/errors.md", slug: "reference/errors" },
  { src: "docs/lint-rules.md", slug: "reference/lint-rules" },
  { src: "docs/language-service.md", slug: "reference/language-service", title: "Editors and language service" },
  { src: "docs/backend.md", slug: "reference/backend" },
];

/** HTML tags that stay as they are; any other bare `<word>` in prose is text and gets escaped. */
const HTML_TAGS = new Set(["br", "kbd", "details", "summary", "sub", "sup", "b", "i", "em", "strong", "code", "a", "img", "p"]);

const MAX_DESCRIPTION = 160;

/** Splits a line into alternating prose and inline-code segments: `[{ code: boolean, text }]`. */
function splitCodeSpans(line) {
  const out = [];
  let last = 0;
  for (const m of line.matchAll(/(`+)(?:(?!\1)[\s\S])*?\1/g)) {
    // `matchAll` with a backreference finds the shortest span opened and closed by the same run of backticks.
    if (m.index > last) out.push({ code: false, text: line.slice(last, m.index) });
    out.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ code: false, text: line.slice(last) });
  return out;
}

function rewriteTarget(target, srcRel, { base, repoUrl, pages }) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return target;
  const hashAt = target.indexOf("#");
  const path = hashAt < 0 ? target : target.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : target.slice(hashAt);
  if (path === "") return target;
  const resolved = posix.normalize(posix.join(posix.dirname(srcRel), path));
  const page = pages.find((p) => p.src === resolved);
  if (page !== undefined) return `${base}/${page.slug}/${hash}`;
  const kind = resolved.endsWith("/") ? "tree" : "blob";
  return `${repoUrl}/${kind}/main/${resolved}${hash}`;
}

function rewriteProse(text, srcRel, opts) {
  return text
    .replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_all, target, title) => `](${rewriteTarget(target, srcRel, opts)}${title})`)
    .replace(/<([A-Za-z][\w.-]*)>/g, (all, name) => (HTML_TAGS.has(name.toLowerCase()) ? all : `&lt;${name}&gt;`));
}

/** Plain text of a Markdown fragment: links reduced to their text, code and emphasis markers dropped. */
function plain(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function describe(paragraph) {
  const text = plain(paragraph);
  const m = /^(.*?[.!?])(?:\s|$)/.exec(text);
  const sentence = m === null ? text : m[1];
  return sentence.length <= MAX_DESCRIPTION ? sentence : `${sentence.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`;
}

/**
 * Converts one Markdown file of the repository to the body of a site page.
 * Returns the title (first `# ` heading, or the page's override), the description (first sentence of the first prose paragraph, at most
 * 160 characters) and the body without the title line. Relative links are rewritten to site pages or to the repository on GitHub; bare
 * `<Name>` outside code is escaped. Fenced code and inline code spans are never touched.
 */
export function transformMarkdown(text, srcRel, { base, repoUrl, pages }) {
  const opts = { base, repoUrl, pages };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let fence = null;
  let heading = null;
  let paragraph = null;
  let paragraphDone = false;
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f !== null) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      if (heading !== null && !paragraphDone) paragraphDone = true; // a fence ends the search for a paragraph
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }
    if (heading === null) {
      const h = /^# (.*?)\s*#*\s*$/.exec(line);
      if (h !== null) {
        heading = plain(h[1]);
        continue; // the title line is dropped
      }
    }
    if (heading !== null && !paragraphDone) {
      const isText = line.trim() !== "" && !/^\s*(#|\||[-*+]\s|\d+[.)]\s|>|<|!\[|:::)/.test(line);
      if (isText) paragraph = paragraph === null ? line : `${paragraph} ${line}`;
      else if (paragraph !== null) paragraphDone = true;
    }
    out.push(
      splitCodeSpans(line)
        .map((seg) => (seg.code ? seg.text : rewriteProse(seg.text, srcRel, opts)))
        .join(""),
    );
  }
  const override = pages.find((p) => p.src === srcRel)?.title;
  while (out.length > 0 && out[0].trim() === "") out.shift();
  return { title: override ?? heading ?? srcRel, description: paragraph === null ? "" : describe(paragraph), body: out.join("\n") };
}

/** The YAML front matter block (with the closing `---` and a blank line). Strings are JSON-quoted, which is valid YAML. */
export function frontmatter({ title, description, sidebar }) {
  const lines = ["---", `title: ${JSON.stringify(title)}`];
  if (description !== undefined && description !== "") lines.push(`description: ${JSON.stringify(description)}`);
  if (sidebar !== undefined) {
    lines.push("sidebar:");
    for (const [key, value] of Object.entries(sidebar)) lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n") + "\n";
}
