// The Markdown transform that turns docs/*.md into site pages.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DOC_PAGES, frontmatter, transformMarkdown } from "../lib/docs-sync.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const opts = { base: "/abf-blueprint-ts", repoUrl: "https://github.com/EmekC/abf-blueprint-ts", pages: DOC_PAGES };
const body = (text, src = "docs/cli.md") => transformMarkdown(text, src, opts).body;

describe("docs transform", () => {
  it("rewrites a link to another published page to its site path", () => {
    assert.ok(body("See [errors](errors.md#abfc2054).").includes("](/abf-blueprint-ts/reference/errors/#abfc2054)"));
  });

  it("rewrites a link to a file that is not a page to GitHub", () => {
    assert.ok(body("See the [README](../README.md).").includes("](https://github.com/EmekC/abf-blueprint-ts/blob/main/README.md)"));
  });

  it("keeps external and in-page links", () => {
    const out = body("[a](https://example.com/x.md) [b](#heading)");
    assert.ok(out.includes("](https://example.com/x.md)") && out.includes("](#heading)"));
  });

  it("does not touch code spans or fenced code", () => {
    const out = body("Use `[x](errors.md)` here.\n\n```md\n[x](errors.md)\n<Documents>\n```\n");
    assert.ok(out.includes("`[x](errors.md)`"));
    assert.equal(out.split("[x](errors.md)").length, 3);
    assert.ok(out.includes("<Documents>"));
  });

  it("escapes a bare tag-like word but keeps real HTML", () => {
    const out = body("Put it in <Documents> and break<br>here.");
    assert.ok(out.includes("&lt;Documents&gt;"));
    assert.ok(out.includes("<br>"));
  });

  it("takes the title from the first heading and removes it", () => {
    const r = transformMarkdown("# My page\n\nFirst sentence. Second one.\n\n## Part\n", "docs/install.md", opts);
    assert.equal(r.title, "My page");
    assert.equal(r.description, "First sentence.");
    assert.ok(!r.body.includes("# My page"));
    assert.ok(r.body.includes("## Part"));
  });

  it("lets the page list override the title", () => {
    assert.equal(transformMarkdown("# Getting started with abfc\n\nText.\n", "docs/getting-started.md", opts).title, "Getting started");
  });

  it("quotes front matter strings", () => {
    const fm = frontmatter({ title: 'A "b"', description: "c: d" });
    assert.ok(fm.includes('title: "A \\"b\\""') && fm.includes('description: "c: d"'));
  });

  it("lists only files that exist", () => {
    for (const p of DOC_PAGES) assert.ok(existsSync(join(root, p.src)), p.src);
  });
});
