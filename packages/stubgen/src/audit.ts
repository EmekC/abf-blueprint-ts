// Text audit of written stub folders: every class must reach UObject through classes that have members.
// Pure: works on the file map (relative path -> text), so the same rule serves the live check and old folders.
import { UOBJECT_PATH, stubFile } from "./names.js";

export interface ChainFinding {
  cls: string;
  /** `opaque-ancestor`, `unresolved-parent` and `cycle` fail the audit; `unknown-parent` is information only. */
  kind: "opaque-ancestor" | "unresolved-parent" | "cycle" | "unknown-parent";
  detail: string;
}

export interface ChainAudit {
  classes: number;
  opaque: number;
  findings: ChainFinding[];
}

interface ParsedClass {
  id: string;
  name: string;
  bpPath: string;
  opaque: boolean;
  /** Local name written after `extends`; null for a class without a parent. */
  parentLocal: string | null;
  file: string;
}

const IMPORT_RE = /^import type \{ (.+) \} from "([^"]+)";$/gm;
const CLASS_RE = /^\/\*\*\n((?: \* .*\n)+) \*\/\nexport declare class (\w+)(?: extends (\w+))? /gm;

/** Stub module specifier of a stub file key (inverse of `stubFile`); null for keys that are not stub files. */
function specOfKey(key: string): string | null {
  if (!key.endsWith(".d.ts")) return null;
  const base = key.slice(0, -".d.ts".length);
  if (base.startsWith("Script/")) return "/" + base;
  if (base.startsWith("Game/")) return "/" + base;
  if (base.startsWith("Mod/")) return "/" + base.slice("Mod/".length);
  return null;
}

/** Checks the parent chain of every class declared in the stub files (keys are paths below the profile folder, `/` separated). */
export function auditStubChains(files: ReadonlyMap<string, string>): ChainAudit {
  // file key -> class name -> class
  const byFile = new Map<string, Map<string, ParsedClass>>();
  // file key -> local name -> { file key of the target module, exported name }
  const importsOf = new Map<string, Map<string, { file: string; name: string }>>();
  for (const [key, text] of files) {
    if (specOfKey(key) === null) continue;
    const classes = new Map<string, ParsedClass>();
    for (const m of text.matchAll(CLASS_RE)) {
      const doc = m[1] ?? "";
      const name = m[2] ?? "";
      const bp = /@bpPath (\S+)/.exec(doc);
      classes.set(name, {
        id: `${key}#${name}`,
        name,
        bpPath: bp?.[1] ?? `${key}#${name}`,
        opaque: /@bpOpaque\b/.test(doc),
        parentLocal: m[3] ?? null,
        file: key,
      });
    }
    byFile.set(key, classes);
    const imports = new Map<string, { file: string; name: string }>();
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[2] ?? "";
      for (const entry of (m[1] ?? "").split(",")) {
        const parts = entry.trim().split(/\s+as\s+/);
        const exported = parts[0] ?? "";
        const local = parts[1] ?? exported;
        if (exported !== "") imports.set(local, { file: stubFile(spec), name: exported });
      }
    }
    importsOf.set(key, imports);
  }

  const resolveParent = (c: ParsedClass): ParsedClass | null | undefined => {
    if (c.parentLocal === null) return null;
    const own = byFile.get(c.file)?.get(c.parentLocal);
    if (own !== undefined) return own;
    const imp = importsOf.get(c.file)?.get(c.parentLocal);
    if (imp === undefined) return undefined;
    return byFile.get(imp.file)?.get(imp.name);
  };

  const all = [...byFile.values()].flatMap((m) => [...m.values()]);
  const findings: ChainFinding[] = [];
  for (const c of all) {
    const parent = resolveParent(c);
    if (parent === undefined) {
      findings.push({ cls: c.bpPath, kind: "unresolved-parent", detail: c.parentLocal ?? "" });
      continue;
    }
    if (c.opaque && parent !== null && parent.bpPath === UOBJECT_PATH) {
      findings.push({ cls: c.bpPath, kind: "unknown-parent", detail: "extends UObject; the real parent is not known" });
    }
    const seen = new Set<string>([c.id]);
    let cur: ParsedClass | null | undefined = parent;
    while (cur !== null && cur !== undefined) {
      if (seen.has(cur.id)) {
        findings.push({ cls: c.bpPath, kind: "cycle", detail: cur.bpPath });
        break;
      }
      seen.add(cur.id);
      if (!c.opaque && cur.opaque) {
        findings.push({ cls: c.bpPath, kind: "opaque-ancestor", detail: cur.bpPath });
        break;
      }
      cur = resolveParent(cur);
    }
  }
  findings.sort((a, b) => (a.cls < b.cls ? -1 : a.cls > b.cls ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return { classes: all.length, opaque: all.filter((c) => c.opaque).length, findings };
}
