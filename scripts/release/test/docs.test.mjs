// Checks of the public documentation set: relative links and anchors resolve, and no user path or guard word is in the text.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { GUARD_WORDS, scanArtifact } from "../lib/scan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const DOCS = [
  "README.md",
  "CHANGELOG.md",
  ...["getting-started", "install", "first-mod", "runtime", "cli", "errors", "config", "backend", "language-service", "lint-rules", "troubleshooting", "known-issues", "releasing"].map(
    (n) => `docs/${n}.md`,
  ),
];

const read = (rel) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

/** The lines outside fenced code blocks, with their 1-based line numbers. */
function proseLines(text) {
  const out = [];
  let fence = null;
  text.split("\n").forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m !== null) {
      if (fence === null) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return;
    }
    if (fence === null) out.push({ n: i + 1, line });
  });
  return out;
}

/** GitHub's anchor of a heading: lowercase, spaces to `-`, punctuation dropped except `-` and `_`; repeats get `-1`, `-2`. */
function anchors(text) {
  const seen = new Map();
  const out = new Set();
  for (const { line } of proseLines(text)) {
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m === null) continue;
    const plain = m[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*]/g, "")
      .toLowerCase();
    const slug = plain.replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    out.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return out;
}

/** Relative links `[text](target)` of the prose (inline code spans removed). */
function links(text) {
  const out = [];
  for (const { n, line } of proseLines(text)) {
    const bare = line.replace(/`[^`]*`/g, "");
    for (const m of bare.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
      out.push({ n, target });
    }
  }
  return out;
}

describe("docs", () => {
  it("lists only files that exist", () => {
    for (const rel of DOCS) assert.ok(existsSync(join(root, rel)), `${rel} is missing`);
  });

  it("every relative link resolves to a file, and every anchor exists in it", () => {
    const problems = [];
    const anchorCache = new Map();
    const anchorsOf = (rel) => {
      if (!anchorCache.has(rel)) anchorCache.set(rel, anchors(read(rel)));
      return anchorCache.get(rel);
    };
    for (const rel of DOCS) {
      const dir = dirname(rel);
      for (const { n, target } of links(read(rel))) {
        const hash = target.indexOf("#");
        const path = hash < 0 ? target : target.slice(0, hash);
        const frag = hash < 0 ? "" : target.slice(hash + 1);
        const file = path === "" ? rel : join(dir, path).replace(/\\/g, "/");
        if (!existsSync(join(root, file))) {
          problems.push(`${rel}:${n}: ${target}: no such file`);
          continue;
        }
        if (frag !== "" && file.endsWith(".md") && !anchorsOf(file).has(frag)) problems.push(`${rel}:${n}: ${target}: no such heading`);
      }
    }
    assert.deepEqual(problems, []);
  });

  it("errors.md has the anchors the other docs link to (#abfcnnnn)", () => {
    const have = anchors(read("docs/errors.md"));
    const missing = [];
    for (const rel of DOCS) {
      for (const { n, target } of links(read(rel))) {
        const m = /(?:^|\/)errors\.md#(abfc\d{4})$/.exec(target);
        if (m !== null && !have.has(m[1])) missing.push(`${rel}:${n}: ${target}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("lint-rules.md has the anchors the other docs link to (#<rule>)", () => {
    const have = anchors(read("docs/lint-rules.md"));
    for (const rule of ["no-heavy-call-in-tick", "no-loop-in-tick", "replicated-write-needs-authority", "rpc-misuse", "no-unbounded-array-growth"]) {
      assert.ok(have.has(rule), `lint-rules.md has no heading for ${rule}`);
    }
    const missing = [];
    for (const rel of DOCS) {
      for (const { n, target } of links(read(rel))) {
        const m = /(?:^|\/)lint-rules\.md#(.+)$/.exec(target);
        if (m !== null && !have.has(m[1])) missing.push(`${rel}:${n}: ${target}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it("contains no user path and no guard word (the release scanner's rules)", () => {
    const ctx = { names: GUARD_WORDS.map((word, i) => ({ word, label: `guard word #${i + 1}` })), repoRoot: "" };
    const found = [];
    for (const rel of DOCS) {
      const buf = Buffer.from(read(rel), "utf8");
      for (const h of scanArtifact({ artifact: "docs", name: rel, buf, ctx })) {
        if (h.rule === "name" || h.rule === "userPath") found.push(`${rel}: ${h.rule}: ${h.detail}`);
      }
    }
    assert.deepEqual(found, []);
  });
});
