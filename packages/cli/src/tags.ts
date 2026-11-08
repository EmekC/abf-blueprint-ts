// The generated `.abfc/tags.d.ts` from the CLI side: the mod's own tag ini files and the rewrite after a build or `abfc stubs`.
import { win32 } from "node:path";
import { parseTagsIni, readGameTags, readTagsFileTags, writeTagsFile } from "@abfc/stubgen";
import type { CliContext } from "./context.js";

/** The tags of the real mod's `Config/Tags/*.ini`; empty when the mod folder is unknown or has none. */
export function modIniTags(ctx: CliContext): string[] {
  const modDir = ctx.env.modDir.value;
  if (modDir === null) return [];
  const host = ctx.deps.host;
  const dir = win32.join(modDir, "Config", "Tags");
  if (!host.exists(dir)) return [];
  const out: string[] = [];
  for (const name of host.readDir(dir).filter((n) => n.toLowerCase().endsWith(".ini")).sort()) {
    try {
      for (const t of parseTagsIni(host.readFile(win32.join(dir, name)))) if (!out.includes(t)) out.push(t);
    } catch {
      // an unreadable ini adds no constants; the build does not depend on it
    }
  }
  return out;
}

/**
 * Rewrites `.abfc/tags.d.ts` from the stored game list, the mod's ini tags and `added` (tags the last apply put into the stage's
 * list, which reach the mod only with `abfc publish`). Tags already in the file stay, so a stage-only tag does not vanish on the next build.
 */
export function refreshTagsFile(ctx: CliContext, added: string[]): void {
  const game = readGameTags(win32.join(ctx.paths.stubsDir, ctx.env.profile.id));
  writeTagsFile(ctx.projectDir, game, [...modIniTags(ctx), ...readTagsFileTags(ctx.projectDir), ...added]);
}
