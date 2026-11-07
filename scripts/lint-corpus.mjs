#!/usr/bin/env node
// Lint a project's src/**/*.ts with @abfc/eslint-plugin's recommended config, to review the findings for
// false positives by hand.
//
//   node scripts/lint-corpus.mjs --project <dir> [--project <dir> ...]
//
// Prints one line per finding: `<file>:<line>:<col> <rule> <message>`, then a count per rule. The exit code is 0 when
// the lint ran (findings are reviewed, they do not fail the script); 2 on bad usage or when ESLint itself fails.
// The project is only read. Requires `npm run build`.
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ESLint } from "eslint";
import * as parser from "@typescript-eslint/parser";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginPath = join(repo, "packages", "eslint-plugin", "dist", "src", "index.js");
if (!existsSync(pluginPath)) {
  console.error("lint-corpus: run `npm run build` first");
  process.exit(2);
}
const plugin = (await import(pathToFileURL(pluginPath).href)).default;

const usage = "usage: node scripts/lint-corpus.mjs --project <dir> [--project <dir> ...]";
const projects = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--project" && argv[i + 1] !== undefined) projects.push(resolve(argv[++i]));
  else {
    console.error(`lint-corpus: unexpected argument ${argv[i]}\n${usage}`);
    process.exit(2);
  }
}
if (projects.length === 0) {
  console.error(usage);
  process.exit(2);
}

const fwd = (p) => p.replaceAll("\\", "/");
let failed = false;

for (const dir of projects) {
  console.log(`== ${fwd(dir)}`);
  if (!existsSync(join(dir, "tsconfig.json"))) {
    console.error(`lint-corpus: ${fwd(dir)} has no tsconfig.json`);
    failed = true;
    continue;
  }
  try {
    const eslint = new ESLint({
      cwd: dir,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["src/**/*.ts"],
          languageOptions: {
            parser,
            parserOptions: { project: join(dir, "tsconfig.json"), tsconfigRootDir: dir },
          },
          ...plugin.configs.recommended,
        },
      ],
    });
    const results = await eslint.lintFiles(["src/**/*.ts"]);
    const perRule = new Map();
    let findings = 0;
    for (const r of results) {
      for (const m of r.messages) {
        findings++;
        const rule = m.ruleId ?? (m.fatal ? "parse-error" : "(no rule)");
        perRule.set(rule, (perRule.get(rule) ?? 0) + 1);
        console.log(`${fwd(relative(dir, r.filePath))}:${m.line}:${m.column} ${rule} ${m.message}`);
      }
    }
    console.log(`${results.length} file(s) linted, ${findings} finding(s)`);
    for (const [rule, n] of [...perRule].sort()) console.log(`  ${rule}: ${n}`);
  } catch (e) {
    console.error(`lint-corpus: ESLint failed on ${fwd(dir)}: ${e instanceof Error ? e.message : String(e)}`);
    failed = true;
  }
}
process.exit(failed ? 2 : 0);
