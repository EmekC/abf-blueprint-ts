#!/usr/bin/env node
// Extract every Blueprint-callable `/Script` function from locally generated stubs for the docs site's node reference.
//
//   node scripts/docs-node-signatures.mjs --stubs <project>/.abfc/stubs/<profile> [--out website/data/node-signatures.json]
//
// <profile> is a stub profile folder with Script/ below it. Only `Script/**/*.d.ts` is read (never Game/ or Mod/). For every static function
// (a function inside `declare namespace <Owner>`) and method (a member of `declare class <Owner>`) that carries a `/Script/<Module>.<Owner>:<Fn>`
// `@bpPath` tag, the script writes owner, module, kind, TS name, the node name from the first doc line (`(<Node Name>).`), the parameters, the
// return type, the signature on one line and the flags (`@bpPure`, `@bpLatent`, `@bpWorldContext`, `@bpUnsupported <label>`, `@deprecated <text>`)
// to --out (default website/data/node-signatures.json; sorted keys, one function per line, no timestamps, so the file only changes when a
// signature does). Reflected tooltip text is not copied.
// The website generator reads that file, because CI has no generated stubs. Stubs from a generator older than 0.7.0 are refused (exit 2):
// they show defaulted parameters as required. Prints `missing: <key>` for curated keys (packages/stubgen/data/descriptions.json) the stubs
// do not contain and exits 1 when any is missing (exit 2 on a usage error).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "usage: node scripts/docs-node-signatures.mjs --stubs <project>/.abfc/stubs/<profile> [--out website/data/node-signatures.json]";

let stubs = null;
let out = join(repo, "website", "data", "node-signatures.json");
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--stubs" && argv[i + 1] !== undefined) stubs = resolve(argv[++i]);
  else if (a === "--out" && argv[i + 1] !== undefined) out = resolve(argv[++i]);
  else {
    console.error(usage);
    process.exit(2);
  }
}
if (stubs === null || !existsSync(join(stubs, "Script"))) {
  console.error(stubs === null ? usage : `docs-node-signatures: no Script/ folder in ${stubs}`);
  process.exit(2);
}

/** True when the dot-separated version `a` is older than `b`. */
function olderThan(a, b) {
  const x = String(a).split(".").map((s) => Number.parseInt(s, 10) || 0);
  const y = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

const lockPath = join(stubs, "stubs.lock.json");
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
if (lock === null || typeof lock.generator !== "string" || olderThan(lock.generator, "0.7.0")) {
  console.error(`docs-node-signatures: stubs from generator ${lock?.generator ?? "unknown"}; run abfc generate with abfc 0.7.0 or later`);
  process.exit(2);
}

const curated = JSON.parse(readFileSync(join(repo, "packages", "stubgen", "data", "descriptions.json"), "utf8")).functions;
const wanted = new Set(Object.keys(curated));

function* dtsFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* dtsFiles(p);
    else if (name.endsWith(".d.ts")) yield p;
  }
}

const tagText = (tag) => (ts.getTextOfJSDocComment(tag.comment) ?? "").trim();
const collapse = (s) => s.replace(/\s+/g, " ").trim();

/** The text of the last parenthesis group of `line` when the line ends with `).`: "Calls A.B (Set Timer by Event)." -> "Set Timer by Event". */
function trailingParen(line) {
  if (!line.endsWith(").")) return null;
  let depth = 0;
  for (let i = line.length - 2; i >= 0; i--) {
    const c = line[i];
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) {
        const inside = line.slice(i + 1, line.length - 2).trim();
        return inside === "" ? null : inside;
      }
    }
  }
  return null;
}

function defaultsOf(tags) {
  const defaults = new Map();
  for (const t of tags) {
    if (t.tagName.text !== "bpDefault") continue;
    const text = tagText(t);
    const m = /^(\S+)\s+"(.*)"$/s.exec(text);
    if (m !== null) defaults.set(m[1], m[2]);
    else {
      const sp = text.search(/\s/);
      if (sp > 0) defaults.set(text.slice(0, sp), text.slice(sp).trim());
      else if (text !== "") defaults.set(text, "");
    }
  }
  return defaults;
}

function entryOf(node, sf, kind, key) {
  const m = /^(\/Script\/[^:]*)\.([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/.exec(key);
  const tags = ts.getJSDocTags(node);
  const has = (name) => tags.some((t) => t.tagName.text === name);
  const deprecated = tags.find((t) => t.tagName.text === "deprecated");
  const doc = ts.getJSDocCommentsAndTags(node).find(ts.isJSDoc);
  const firstLine = (ts.getTextOfJSDocComment(doc?.comment) ?? "").split(/\r?\n/)[0].trim();
  const defaults = defaultsOf(tags);
  const params = node.parameters.map((p) => ({
    name: p.name.getText(sf),
    type: p.type === undefined ? "unknown" : collapse(p.type.getText(sf)),
    optional: p.questionToken !== undefined || p.initializer !== undefined || p.dotDotDotToken !== undefined,
    default: defaults.get(p.name.getText(sf)) ?? null,
  }));
  const returns = {
    type: node.type === undefined ? "void" : collapse(node.type.getText(sf)),
    fields: node.type !== undefined && ts.isTypeLiteralNode(node.type) ? node.type.members.map((mem) => (mem.name === undefined ? "" : mem.name.getText(sf))) : null,
  };
  return {
    owner: m[2],
    module: m[1],
    kind,
    tsName: node.name.text,
    displayName: trailingParen(firstLine),
    params,
    returns,
    signature: collapse(node.getText(sf)),
    pure: has("bpPure"),
    latent: has("bpLatent"),
    worldContext: has("bpWorldContext"),
    unsupported: tags.filter((t) => t.tagName.text === "bpUnsupported").map(tagText).filter((s) => s !== "").sort(),
    blocked: deprecated === undefined ? null : tagText(deprecated),
  };
}

const found = {};
for (const file of dtsFiles(join(stubs, "Script"))) {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    let kind = null;
    if (ts.isFunctionDeclaration(node) && node.parent !== undefined && ts.isModuleBlock(node.parent)) kind = "static";
    else if (ts.isMethodDeclaration(node) && node.parent !== undefined && ts.isClassDeclaration(node.parent)) {
      kind = ts.getModifiers(node)?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword) === true ? "static" : "method";
    }
    if (kind !== null && node.name !== undefined && ts.isIdentifier(node.name)) {
      const tag = ts.getJSDocTags(node).find((t) => t.tagName.text === "bpPath");
      const key = tag === undefined ? "" : tagText(tag);
      if (/^(\/Script\/[^:]*)\.([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/.test(key)) found[key] = entryOf(node, sf, kind, key);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

let missing = 0;
for (const key of [...wanted].sort()) {
  if (found[key] === undefined) {
    console.log(`missing: ${key}`);
    missing++;
  }
}

const keys = Object.keys(found).sort();
const lines = [
  "{",
  `  "version": 2,`,
  `  "profile": ${JSON.stringify(basename(stubs))},`,
  `  "generator": ${JSON.stringify(lock.generator)},`,
  `  "modEditorVersion": ${JSON.stringify(lock.modEditorVersion ?? null)},`,
  `  "functions": {`,
  ...keys.map((k, i) => `    ${JSON.stringify(k)}: ${JSON.stringify(found[k])}${i < keys.length - 1 ? "," : ""}`),
  "  }",
  "}",
];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
const modules = new Set(keys.map((k) => found[k].module));
const blocked = keys.filter((k) => found[k].blocked !== null).length;
console.log(`docs-node-signatures: ${keys.length} functions in ${modules.size} modules (${blocked} blocked) written to ${out}`);
process.exit(missing > 0 ? 1 : 0);
