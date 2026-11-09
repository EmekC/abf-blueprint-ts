// Generates the pages of the site from the repository's docs: website/src/content/docs/** (everything except the hand-written index.mdx)
// and website/public/search-index.json. Run by `npm run generate` (also part of `npm run dev` and `npm run build`).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, REPO_URL, SITE } from "../site.mjs";
import { DOC_PAGES, frontmatter, transformMarkdown } from "../lib/docs-sync.mjs";
import { buildNodes, llmsNodesText, modulePages, nodesIndexPage, notFoundPage } from "../lib/nodes.mjs";
import { buildSearchIndex } from "../lib/search-index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const site = resolve(root, "website");
const outDir = join(site, "src", "content", "docs");

const problems = [];
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** Relative `.md` links in prose (outside fences and inline code) of a docs file: `[{ target, line }]`. */
function relativeMdLinks(text) {
  const found = [];
  let fence = null;
  text.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f !== null) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const prose = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, "");
    for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const path = target.split("#")[0];
      if (path.endsWith(".md")) found.push({ target: path, line: i + 1 });
    }
  });
  return found;
}

// Links between docs files must stay valid on GitHub and on the site.
for (const file of readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).sort()) {
  const srcRel = `docs/${file}`;
  for (const { target, line } of relativeMdLinks(read(srcRel))) {
    const resolved = posix.normalize(posix.join(posix.dirname(srcRel), target));
    if (!DOC_PAGES.some((p) => p.src === resolved) && !existsSync(join(root, resolved))) {
      problems.push(`${srcRel}:${line}: link to ${target} points to a file that does not exist`);
    }
  }
}

// Clear the generated pages; index.mdx is written by hand.
mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(outDir)) {
  if (name !== "index.mdx") rmSync(join(outDir, name), { recursive: true, force: true });
}

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const pages = [];
for (const page of DOC_PAGES) {
  if (!existsSync(join(root, page.src))) {
    problems.push(`${page.src}: listed in DOC_PAGES but missing`);
    continue;
  }
  const { title, description, body } = transformMarkdown(read(page.src), page.src, { base: BASE, repoUrl: REPO_URL, pages: DOC_PAGES });
  write(join(outDir, `${page.slug}.md`), frontmatter({ title, description }) + body.trimEnd() + "\n");
  pages.push({ slug: page.slug, title });
}

const descriptions = JSON.parse(read("packages/stubgen/data/descriptions.json"));
const signaturesPath = join(site, "data", "node-signatures.json");
let nodes = [];
let modules = [];
let meta = { generator: null, modEditorVersion: null, profile: null };
if (!existsSync(signaturesPath)) {
  problems.push("website/data/node-signatures.json missing; run scripts/docs-node-signatures.mjs");
} else {
  const signatures = JSON.parse(readFileSync(signaturesPath, "utf8"));
  meta = { generator: signatures.generator, modEditorVersion: signatures.modEditorVersion, profile: signatures.profile };
  try {
    nodes = buildNodes(descriptions, signatures, BASE);
    modules = modulePages(nodes);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
}

if (problems.length > 0) {
  console.error(`docs: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

write(join(outDir, "reference", "nodes", "index.md"), nodesIndexPage(nodes, modules, meta, BASE));
write(join(outDir, "404.md"), notFoundPage(BASE));

// The node and module pages are Astro routes (src/pages/reference/**) that read this file.
const generatedDir = join(site, "src", "generated");
rmSync(generatedDir, { recursive: true, force: true });
write(join(generatedDir, "nodes.json"), JSON.stringify({ nodes, modules }));
write(join(site, "public", "llms-nodes.txt"), llmsNodesText(nodes, SITE + BASE, meta));

const index = buildSearchIndex({ nodes, runtimeMd: read("docs/runtime.md"), errorsMd: read("docs/errors.md"), pages, base: BASE });
write(join(site, "public", "search-index.json"), JSON.stringify(index) + "\n");

console.log(`docs: ${pages.length} pages, ${nodes.length} nodes in ${modules.length} modules, ${index.entries.length} search entries`);
