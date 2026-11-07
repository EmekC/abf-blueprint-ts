#!/usr/bin/env node
// Check the stub description lines of every stub function a project calls.
//
//   node scripts/stub-desc-coverage.mjs --project <dir> [--project <dir> ...]
//
// For every call expression in the project's source files (src/, tests included) the callee declaration is resolved;
// declarations under <dir>/.abfc/stubs/ are kept. One line is printed per distinct `@bpPath`:
//   <bpPath>  <description line>  curated|reflected|fallback|hand-made
// Exit 1 when a description line does not match /^.+ \(.+\)\.$/ (one-line description ending with the node name), or
// when a function is not covered: a /Script function of an engine module (Engine, UMG, ...) and a /Game function must be in the
// curated table (packages/stubgen/data/descriptions.json). A /Script function of any other (game) module is not curated (the shipped
// table names no game module): it shows the engine-reflected tooltip ("reflected") when the editor has one, else the
// `Calls <Class>.<Function> (<Node Name>).` fallback (printed as "fallback", no problem: the line format is still checked). Hand-made members of the mod's own assets (stubs under .abfc/stubs/<ue>/Mod/) are exempt.
// The project is only read. Requires `npm run build`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const compilerPath = join(repo, "packages", "compiler", "dist", "src", "index.js");
if (!existsSync(compilerPath)) {
  console.error("stub-desc-coverage: run `npm run build` first");
  process.exit(2);
}
const { loadProgram } = await import(pathToFileURL(compilerPath).href);
const curated = JSON.parse(readFileSync(join(repo, "packages", "stubgen", "data", "descriptions.json"), "utf8")).functions;

const usage = "usage: node scripts/stub-desc-coverage.mjs --project <dir> [--project <dir> ...]";
const projects = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project" && argv[i + 1] !== undefined) projects.push(resolve(argv[++i]));
  else {
    console.error(`stub-desc-coverage: unexpected argument ${argv[i]}\n${usage}`);
    process.exit(2);
  }
}
if (projects.length === 0) {
  console.error(usage);
  process.exit(2);
}

// Engine modules: their functions must be curated. Any other /Script module is a game module (reflected tooltips count).
const ENGINE_MODULES = new Set(["Engine", "CoreUObject", "UMG", "Slate", "SlateCore", "InputCore", "EnhancedInput", "GameplayTags", "GameplayAbilities", "AIModule", "NavigationSystem", "PhysicsCore", "Niagara", "MovieScene", "LevelSequence"]);
const isGameScript = (bpPath) => {
  const m = /^\/Script\/([^./]+)\./.exec(bpPath);
  return m !== null && !ENGINE_MODULES.has(m[1]);
};

const fwd = (p) => p.replaceAll("\\", "/");
const LINE = /^.+ \(.+\)\.$/;
let bad = 0;

for (const dir of projects) {
  console.log(`== ${fwd(dir)}`);
  const loaded = loadProgram(dir);
  const { program, checker } = loaded;
  const stubsRoot = fwd(join(dir, ".abfc", "stubs")) + "/";
  const found = new Map(); // bpPath -> { line, handMade }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const sig = checker.getResolvedSignature(node);
      const decl = sig?.declaration;
      if (decl !== undefined && fwd(decl.getSourceFile().fileName).startsWith(stubsRoot)) {
        const tags = sig.getJsDocTags(checker);
        const bpPath = tags.find((t) => t.name === "bpPath")?.text?.map((p) => p.text).join("").trim();
        if (bpPath !== undefined && !found.has(bpPath)) {
          const doc = ts.displayPartsToString(sig.getDocumentationComment(checker)).trim();
          const rel = fwd(decl.getSourceFile().fileName).slice(stubsRoot.length);
          const handMade = /^[^/]+\/Mod\//.test(rel);
          found.set(bpPath, { line: doc, handMade });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const sf of program.getSourceFiles()) {
    const f = fwd(sf.fileName);
    if (sf.isDeclarationFile || f.includes("/node_modules/") || !f.startsWith(fwd(dir) + "/")) continue;
    visit(sf);
  }

  let calledCount = 0;
  for (const [bpPath, { line, handMade }] of [...found].sort((a, b) => a[0].localeCompare(b[0]))) {
    calledCount++;
    const isCurated = Object.hasOwn(curated, bpPath);
    const reflected = !isCurated && isGameScript(bpPath) && !/^Calls [^ ]+ \(.+\)\.$/.test(line);
    const kind = handMade ? "hand-made" : isCurated ? "curated" : reflected ? "reflected" : "fallback";
    const covered = handMade || isCurated || isGameScript(bpPath);
    const problems = [];
    if (line.includes("\n") || !LINE.test(line)) problems.push("description line does not match `<text> (<Node Name>).`");
    if (!covered) problems.push("not in the curated table");
    console.log(`${bpPath}  ${line.replaceAll("\n", " | ")}  ${kind}${problems.length > 0 ? `  <-- ${problems.join("; ")}` : ""}`);
    if (problems.length > 0) bad++;
  }
  console.log(`${calledCount} stub function(s) called`);
}
console.log(bad === 0 ? "stub-desc-coverage: OK" : `stub-desc-coverage: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
