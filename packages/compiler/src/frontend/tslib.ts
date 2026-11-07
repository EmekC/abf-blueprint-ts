// Where TypeScript finds its `lib.*.d.ts` files. TypeScript looks next to `ts.sys.getExecutingFilePath()`,
// which in abfc.exe is the exe itself; the exe ships the libs in its runtime folder instead.
import { dirname, win32 } from "node:path";
import ts from "typescript";

/**
 * Makes TypeScript load its `lib*.d.ts` from `getDir()` (called on each lookup, so the folder can be
 * extracted lazily). Returns a function that restores the original behaviour.
 */
export function useTypeScriptLibDir(getDir: () => string): () => void {
  const original = ts.sys.getExecutingFilePath;
  ts.sys.getExecutingFilePath = () => win32.join(getDir(), "typescript.js");
  return () => {
    ts.sys.getExecutingFilePath = original;
  };
}

/** The folder TypeScript currently loads `lib*.d.ts` from. */
export function defaultLibDir(): string {
  return dirname(ts.getDefaultLibFilePath({}));
}
