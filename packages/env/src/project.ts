import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { AbfcError, envError } from "./errors.js";
import { PROJECT_CONFIG_FILE } from "./config.js";
import type { Host } from "./discover.js";

/** Walks up from `start` to the folder holding `abf.config.json`. ABFC1021 when none is found. */
export function findProjectDir(start: string, exists: (p: string) => boolean = existsSync): string {
  const tried: Array<{ source: string; detail: string }> = [];
  let dir = win32.resolve(start);
  for (;;) {
    if (exists(win32.join(dir, PROJECT_CONFIG_FILE))) return dir;
    tried.push({ source: dir, detail: `no ${PROJECT_CONFIG_FILE}` });
    const parent = win32.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw envError(
    1021,
    `${PROJECT_CONFIG_FILE} not found in ${start} or any parent folder.`,
    tried,
    `run abfc inside your TypeScript project, or create ${PROJECT_CONFIG_FILE} there.`,
  );
}

/** ABFC1020 (exit 3) when the folder or any ancestor holds a `*.uplugin` file (the project would sit inside a mod). */
export function assertNotInModFolder(host: Host, dir: string): void {
  let cur = win32.resolve(dir);
  for (;;) {
    if (host.exists(cur)) {
      const plugin = host.readDir(cur).find((n) => n.toLowerCase().endsWith(".uplugin"));
      if (plugin !== undefined) {
        throw new AbfcError(
          {
            severity: "error",
            code: "ABFC1020",
            message: `the project folder ${dir} is inside a mod folder (${win32.join(cur, plugin)}); abfc never writes there.`,
            tried: [{ source: cur, detail: `holds ${plugin}` }],
            fix: "move the TypeScript project outside every mod folder (for example next to the mods folder).",
          },
          3,
        );
      }
    }
    const parent = win32.dirname(cur);
    if (parent === cur) return;
    cur = parent;
  }
}
