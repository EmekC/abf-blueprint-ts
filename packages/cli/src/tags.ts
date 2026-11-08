// The generated `.abfc/tags.d.ts` from the CLI side: the mod's own tag ini files and the rewrite after a build or `abfc stubs`.
import { win32 } from "node:path";
import { parseTagsIni, readGameTags, readTagsFileTags, writeTagsFile } from "@abfc/stubgen";
import type { CliContext } from "./context.js";

/** The tags of the real mod's `Config/Tags/*.ini`; empty when the mod folder is unknown or has none. */
export function modIniTags(ctx: CliContext): string[] {
  return iniTagsOf(ctx.deps.host, ctx.env.modDir.value);
}

/** The same from a host and a mod folder (`abfc init` has no context yet). */
export function iniTagsOf(host: CliContext["deps"]["host"], modDir: string | null): string[] {
  if (modDir === null) return [];
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
 * `abfc stubs` passes `stagingPath` instead: it rebuilds the file from the game list, the mod's ini and the stage's own
 * `Config/Tags/*.ini` (where a stage-only tag lives), so a tag that was removed everywhere also leaves the file. An empty or null
 * `stagingPath` (no stage, or a backend that does not report it) then adds no stage tags.
 */
export function refreshTagsFile(ctx: CliContext, added: string[], o: { stagingPath?: string | null } = {}): void {
  const game = readGameTags(win32.join(ctx.paths.stubsDir, ctx.env.profile.id));
  const fromStubs = o.stagingPath !== undefined;
  const sp = o.stagingPath ?? "";
  const stage = fromStubs && sp !== "" ? iniTagsOf(ctx.deps.host, sp) : [];
  writeTagsFile(ctx.projectDir, game, [...modIniTags(ctx), ...(fromStubs ? stage : readTagsFileTags(ctx.projectDir)), ...added]);
}
