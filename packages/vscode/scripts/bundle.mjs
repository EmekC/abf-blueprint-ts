// Bundles the compiled extension (dist/src/extension.js) into dist/extension.js and copies the config schema next to it.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(pkgDir, "dist", "src", "extension.js");
const schemaSource = join(pkgDir, "..", "cli", "schema", "abf.config.schema.json");

export async function bundle() {
  if (!existsSync(entry)) {
    throw new Error("packages/vscode/dist/src/extension.js is missing: run npm run build first");
  }
  if (!existsSync(schemaSource)) {
    throw new Error("packages/cli/schema/abf.config.schema.json is missing");
  }
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    outfile: join(pkgDir, "dist", "extension.js"),
    logLevel: "info",
  });
  const schemaDir = join(pkgDir, "dist", "schema");
  mkdirSync(schemaDir, { recursive: true });
  copyFileSync(schemaSource, join(schemaDir, "abf.config.schema.json"));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  bundle().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
