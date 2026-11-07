// Derived asset paths (docs/design.md 18.1): where a `@blueprint` / `@struct` class lives follows from its file, not from the source text.
import { resolve } from "node:path";
import ts from "typescript";
import { DEFAULT_CLASS_MANAGER_TABLE, DEFAULT_SOURCE_ROOT, classNameProblem, joinModPath, modRelativeProblem, packagePathProblem, segmentProblem, toModRelative } from "@abfc/ir";
import type { Diagnostic } from "@abfc/ir";
import { spanOf } from "./diag.js";
import type { LoadedProgram } from "./program.js";

/** What the frontend needs from the project config to derive asset paths. */
export interface CompilerProjectConfig {
  mod: string;
  /** Source root below the project directory (default `src`). */
  sourceRoot?: string;
  /** Emit the migration warnings ABFC2005, ABFC2006, ABFC2008 and ABFC2076 (set for schema-2 projects). */
  migrationHints?: boolean;
  /** Mod-relative folder of the class-manager rows (default `DataTables/DT_ClassManager`). */
  classManagerTable?: string;
}

export interface PathContext {
  mod: string;
  /** Absolute source root, forward slashes, no trailing slash. */
  sourceRootAbs: string;
  /** Source root as configured (project relative), forward slashes. */
  sourceRootRel: string;
  migrationHints: boolean;
  classManagerTable: string;
  /** Absolute project directory, forward slashes, no trailing slash. */
  projectDir: string;
}

const contexts = new WeakMap<ts.SourceFile, PathContext>();

const fwd = (p: string): string => p.replaceAll("\\", "/");
const trimSlash = (p: string): string => p.replace(/\/+$/, "");

/** Sets the path context of every source file (not `.d.ts`) of the program. */
export function bindPathContext(loaded: LoadedProgram, config: CompilerProjectConfig): void {
  const sourceRootRel = trimSlash(fwd(config.sourceRoot ?? DEFAULT_SOURCE_ROOT));
  const ctx: PathContext = {
    mod: config.mod,
    sourceRootAbs: trimSlash(fwd(resolve(loaded.projectDir, config.sourceRoot ?? DEFAULT_SOURCE_ROOT))),
    sourceRootRel,
    migrationHints: config.migrationHints === true,
    classManagerTable: config.classManagerTable ?? DEFAULT_CLASS_MANAGER_TABLE,
    projectDir: trimSlash(fwd(loaded.projectDir)),
  };
  for (const sf of loaded.program.getSourceFiles()) {
    if (!sf.isDeclarationFile) contexts.set(sf, ctx);
  }
}

/** The path context bound to a source file, if any. */
export function pathContextOf(sf: ts.SourceFile): PathContext | undefined {
  return contexts.get(sf);
}

/**
 * Warning ABFC2008 for every import of the mod's own stubs by `/<mod>/...` (use `@mod/...`). Empty unless the file has a path
 * context with `migrationHints`.
 */
export function modImportHints(sf: ts.SourceFile): Diagnostic[] {
  const ctx = contexts.get(sf);
  if (ctx === undefined || !ctx.migrationHints) return [];
  const prefix = `/${ctx.mod}/`.toLowerCase();
  const out: Diagnostic[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier;
    if (!spec.text.toLowerCase().startsWith(prefix)) continue;
    out.push({
      severity: "warning",
      code: "ABFC2008",
      message: `import from "${spec.text}" names the mod; use "@mod/${spec.text.slice(prefix.length)}"`,
      span: spanOf(spec, ctx.projectDir),
      fix: 'import the stub through "@mod/..." (quick fix)',
    });
  }
  return out;
}

export interface AssetPathProblem {
  severity: "error" | "warning";
  code: string;
  message: string;
  node: ts.Node;
  fix?: string;
}

export interface AssetPathInfo {
  /** The asset's package path (explicit, else derived); undefined when there is none or it is invalid. */
  path?: string;
  /** The path derived from the file location, when there is one. */
  derived?: string;
  explicit?: { text: string; node: ts.Expression; prop: ts.PropertyAssignment; form: "relative" | "absolute" };
  problems: AssetPathProblem[];
}

const FIX_RENAME = "rename the folder or class, or give path:";

/**
 * Asset path of a class declaration carrying `@blueprint(...)` or `@struct(...)` (decorator matched syntactically by the callee's
 * identifier). undefined when the class has no such decorator call.
 */
export function assetPathOf(decl: ts.ClassDeclaration, decorator: "blueprint" | "struct"): AssetPathInfo | undefined {
  let call: ts.CallExpression | undefined;
  for (const d of ts.getDecorators(decl) ?? []) {
    const e = d.expression;
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === decorator) {
      call = e;
      break;
    }
  }
  if (call === undefined) return undefined;
  const opts = call.arguments[0];
  const info: AssetPathInfo = { problems: [] };
  if (opts !== undefined && ts.isObjectLiteralExpression(opts)) {
    for (const p of opts.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) || p.name.text !== "path") continue;
      const init = p.initializer;
      if (!ts.isStringLiteral(init) && !ts.isNoSubstitutionTemplateLiteral(init)) continue;
      info.explicit = { text: init.text, node: init, prop: p, form: init.text.startsWith("/") ? "absolute" : "relative" };
      break;
    }
  }
  const sf = decl.getSourceFile();
  const ctx = contexts.get(sf);
  if (ctx === undefined) {
    // no project context (pre-1.0 behaviour): an absolute literal path only
    const t = info.explicit?.text;
    if (t !== undefined && t.startsWith("/") && !t.endsWith("/")) info.path = t;
    return info;
  }

  const name = decl.name?.text;
  const here = opts ?? call;
  const kind = decorator === "struct" ? "@struct" : "@blueprint";
  const at = decl.name ?? decl;

  // derived path
  const derivedProblems: AssetPathProblem[] = [];
  const fileFwd = fwd(sf.fileName);
  const relProject = fileFwd.toLowerCase().startsWith(`${ctx.projectDir.toLowerCase()}/`) ? fileFwd.slice(ctx.projectDir.length + 1) : fileFwd;
  if (name === undefined) {
    derivedProblems.push({ severity: "error", code: "ABFC2002", message: `a ${kind} class needs a name`, node: at });
  } else if (fileFwd.toLowerCase().startsWith(`${ctx.sourceRootAbs.toLowerCase()}/`)) {
    const rel = fileFwd.slice(ctx.sourceRootAbs.length + 1);
    const folders = rel.split("/").slice(0, -1);
    let bad: AssetPathProblem | undefined;
    for (const seg of folders) {
      const why = segmentProblem(seg);
      if (why !== null) {
        bad = { severity: "error", code: "ABFC2002", message: `folder "${seg}" of ${relProject} ${why}`, node: at, fix: FIX_RENAME };
        break;
      }
    }
    if (bad === undefined) {
      const why = classNameProblem(name);
      if (why !== null) bad = { severity: "error", code: "ABFC2002", message: `class name "${name}" ${why}`, node: at, fix: FIX_RENAME };
    }
    if (bad === undefined) {
      const rel2 = [...folders, name].join("/");
      const full = joinModPath(ctx.mod, rel2);
      const why = packagePathProblem(full);
      if (why !== null) bad = { severity: "error", code: "ABFC2002", message: `asset path ${full} ${why}`, node: at, fix: FIX_RENAME };
      else info.derived = full;
    }
    if (bad !== undefined) derivedProblems.push(bad);
  } else if (info.explicit === undefined) {
    derivedProblems.push({
      severity: "error",
      code: "ABFC2003",
      message: `${relProject} is outside the source root "${ctx.sourceRootRel}": move it under ${ctx.sourceRootRel}/ or give path:`,
      node: at,
    });
  }

  const ex = info.explicit;
  if (ex === undefined) {
    info.problems.push(...derivedProblems);
    if (info.derived !== undefined) info.path = info.derived;
    return info;
  }

  // an explicit path wins; derived problems do not matter (that is what the override is for)
  let rel: string;
  if (ex.form === "absolute") {
    if (toModRelative(ctx.mod, ex.text) === null || ex.text.endsWith("/")) {
      info.problems.push({ severity: "error", code: "ABFC2001", message: `${kind} path of ${name ?? "(anonymous)"} must be a string literal under "/${ctx.mod}/"`, node: here });
      return info;
    }
    rel = ex.text.slice(ctx.mod.length + 2);
  } else {
    rel = ex.text;
  }
  const why = modRelativeProblem(rel);
  if (why !== null) {
    info.problems.push({ severity: "error", code: "ABFC2002", message: `${kind} path ${why}`, node: ex.node });
    return info;
  }
  const full = joinModPath(ctx.mod, rel);
  const long = packagePathProblem(full);
  if (long !== null) {
    info.problems.push({ severity: "error", code: "ABFC2002", message: `asset path ${full} ${long}`, node: ex.node });
    return info;
  }
  info.path = full;
  if (ctx.migrationHints) {
    if (info.derived !== undefined && full === info.derived) {
      info.problems.push({
        severity: "warning",
        code: "ABFC2006",
        message: `path "${ex.text}" is the path abfc derives for ${name ?? "(anonymous)"}; remove it`,
        node: ex.prop,
        fix: "remove path: (quick fix)",
      });
    } else if (ex.form === "absolute") {
      const rel2 = toModRelative(ctx.mod, ex.text) ?? rel;
      info.problems.push({
        severity: "warning",
        code: "ABFC2005",
        message: `path names the mod; write it relative: "${rel2}"`,
        node: ex.prop,
        fix: "write the path relative to the mod (quick fix)",
      });
    }
  }
  return info;
}
