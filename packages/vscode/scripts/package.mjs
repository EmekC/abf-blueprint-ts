// Bundles the extension and packs it into <repo>/build/vsix/abfc-vscode-<version>.vsix (never installed or published).
import { createVSIX } from "@vscode/vsce";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.mjs";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgDir, "..", "..");

async function main() {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  await bundle();
  const outDir = join(repoRoot, "build", "vsix");
  mkdirSync(outDir, { recursive: true });
  const packagePath = join(outDir, `${manifest.name}-${manifest.version}.vsix`);
  await createVSIX({ cwd: pkgDir, packagePath, dependencies: false });
  console.log(`${packagePath} (${statSync(packagePath).size} bytes)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
