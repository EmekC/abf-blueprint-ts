import { win32 } from "node:path";
import type { Host } from "../src/index.js";

type RunResult = { status: number | null; stdout: string; stderr: string };

export interface FakeHostOptions {
  env?: NodeJS.ProcessEnv;
  files?: Record<string, string>;
  dirs?: string[];
  run?: (cmd: string, args: string[]) => Partial<RunResult> | undefined;
  nodeVersion?: string;
  stats?: Record<string, { size: number; mtimeMs: number }>;
}

const key = (p: string): string => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();

/** In-memory host: files and folders are given up front, `run` is scripted. */
export function fakeHost(o: FakeHostOptions = {}): Host & { files: Map<string, string>; dirs: Set<string>; calls: string[] } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const calls: string[] = [];
  const names = new Map<string, string>(); // key -> original-case basename
  const addDirChain = (p: string): void => {
    let cur = key(p);
    let orig = win32.normalize(p).replace(/[\\/]+$/, "");
    for (;;) {
      dirs.add(cur);
      names.set(cur, win32.basename(orig));
      const parent = key(win32.dirname(cur));
      if (parent === cur) return;
      cur = parent;
      orig = win32.dirname(orig);
    }
  };
  for (const [p, text] of Object.entries(o.files ?? {})) {
    files.set(key(p), text);
    names.set(key(p), win32.basename(p));
    addDirChain(win32.dirname(p));
  }
  for (const d of o.dirs ?? []) addDirChain(d);

  return {
    env: o.env ?? {},
    files,
    dirs,
    calls,
    exists: (p) => files.has(key(p)) || dirs.has(key(p)),
    readFile: (p) => {
      const t = files.get(key(p));
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    readDir: (p) => {
      const base = key(p);
      const names2 = new Set<string>();
      for (const f of [...files.keys(), ...dirs]) {
        if (f === base) continue;
        if (key(win32.dirname(f)) === base) names2.add(names.get(f) ?? win32.basename(f));
      }
      return [...names2];
    },
    stat: (p) => o.stats?.[key(p)] ?? (files.has(key(p)) ? { size: files.get(key(p))!.length, mtimeMs: 1000 } : null),
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      const r = o.run?.(cmd, args);
      return { status: r?.status ?? 1, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
    },
    platform: "win32",
    nodeVersion: o.nodeVersion ?? "v24.0.0",
  };
}
