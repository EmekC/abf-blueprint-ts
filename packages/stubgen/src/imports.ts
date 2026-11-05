// Per-file import bookkeeping for generated stubs.
import { moduleBase, moduleSpecifier, tsIdent } from "./names.js";
import { RUNTIME_NAMES } from "./typemap.js";
import type { RuntimeName, TypeCtx, TypeRef } from "./typemap.js";

export const RUNTIME_SPECIFIER = "@abfc/runtime";

/** Collects the imports of one stub file; hands out local names, aliasing on collisions (`<Module>_<X>`). */
export class FileBuilder implements TypeCtx {
  readonly spec: string;
  private readonly used = new Set<string>(RUNTIME_NAMES);
  private readonly declared = new Set<string>();
  private readonly runtimeUsed = new Set<RuntimeName>();
  /** spec -> exported ident -> local name */
  private readonly imports = new Map<string, Map<string, string>>();
  private readonly byPath = new Map<string, string>();

  constructor(spec: string, declaredPaths: Iterable<string>) {
    this.spec = spec;
    for (const p of declaredPaths) {
      this.declared.add(p);
      this.used.add(tsIdent(p));
    }
  }

  runtime(name: RuntimeName): string {
    this.runtimeUsed.add(name);
    return name;
  }

  ref(path: string, _kind: TypeRef["kind"]): string {
    const ident = tsIdent(path);
    const spec = moduleSpecifier(path);
    if (this.declared.has(path) || spec === this.spec) return ident;
    const cached = this.byPath.get(path);
    if (cached !== undefined) return cached;
    let local = ident;
    if (this.used.has(local)) {
      const base = `${moduleBase(spec)}_${ident}`;
      local = base;
      for (let n = 2; this.used.has(local); n++) local = `${base}${n}`;
    }
    this.used.add(local);
    let m = this.imports.get(spec);
    if (!m) this.imports.set(spec, (m = new Map()));
    m.set(ident, local);
    this.byPath.set(path, local);
    return local;
  }

  /** `import type` lines: runtime first, then the other modules sorted by specifier. */
  renderImports(): string[] {
    const lines: string[] = [];
    if (this.runtimeUsed.size > 0) {
      lines.push(`import type { ${[...this.runtimeUsed].sort().join(", ")} } from "${RUNTIME_SPECIFIER}";`);
    }
    for (const spec of [...this.imports.keys()].sort()) {
      const m = this.imports.get(spec)!;
      const names = [...m.entries()]
        .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        .map(([exported, local]) => (exported === local ? exported : `${exported} as ${local}`));
      lines.push(`import type { ${names.join(", ")} } from "${spec}";`);
    }
    return lines;
  }
}

export function jsdoc(tags: string[], indent: string): string {
  return `${indent}/**\n${tags.map((t) => `${indent} * ${t}`).join("\n")}\n${indent} */\n`;
}
