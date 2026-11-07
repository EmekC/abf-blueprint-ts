// The language service half of the plugin (ES module): abfc diagnostics, Blueprint hover text and quick fixes.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type ts from "typescript";
import {
  TS_VERSION,
  checkProject,
  describeIrNode,
  idivFix,
  irNodesAt,
  loadedFromProgram,
  optionalChainFix,
  ownedManualFilter,
  tsDiagnostics,
} from "@abfc/compiler";
import type { LoadedProgram, ProjectCheck, TextEdit } from "@abfc/compiler";
import { findProjectDir, loadProfile, loadProjectConfig } from "@abfc/env";
import type { PluginInfo } from "./info.js";

export interface AbfcService {
  /** Marks the project dirty when a manifest changed since the program was built; call before asking the language service for results. */
  sync(): void;
  /** The abfc diagnostics (not TypeScript's own) of one file. */
  diagnostics(fileName: string): ts.Diagnostic[];
  quickInfo(fileName: string, position: number, base: ts.QuickInfo | undefined): ts.QuickInfo | undefined;
  codeFixes(fileName: string, start: number, end: number, errorCodes: readonly number[], base: readonly ts.CodeFixAction[]): readonly ts.CodeFixAction[];
  supportedCodeFixes(base: readonly string[]): readonly string[];
}

const IDIV_CODES = [2010];
const OPTIONAL_CHAIN_CODES = [2531, 2532, 18047, 18048, 18049];
const MAX_HOVER_NODES = 6;
const TOKEN_TTL_MS = 1000;

const fwd = (p: string): string => p.replaceAll("\\", "/");

/** Project-relative file name with forward slashes, as the compiler writes diagnostic spans. */
const relFile = (root: string, fileName: string): string => fwd(relative(root, fileName));

/** Changes whenever a manifest or a retired list changes (the stubs' `_Manual` interfaces depend on them). */
function manifestToken(projectDir: string): string {
  let max = 0;
  const bump = (file: string): void => {
    try {
      max = Math.max(max, statSync(file).mtimeMs);
    } catch {
      // vanished between readdir and stat
    }
  };
  const manifests = join(projectDir, ".abfc", "manifest");
  if (existsSync(manifests)) {
    for (const f of readdirSync(manifests)) if (f.endsWith(".json")) bump(join(manifests, f));
  }
  const stubs = join(projectDir, ".abfc", "stubs");
  if (existsSync(stubs)) {
    for (const profile of readdirSync(stubs)) bump(join(stubs, profile, "retired.json"));
  }
  return String(max);
}

/** null (with the reason logged) when the plugin must stay out: another TypeScript version or no abfc project. */
export function createService(tsMod: typeof ts, info: PluginInfo): AbfcService | null {
  const log = (text: string): void => info.project.projectService.logger.info(`[abfc] ${text}`);
  if (tsMod.version !== TS_VERSION) {
    log(`disabled: tsserver runs TypeScript ${tsMod.version} but abfc was built against ${TS_VERSION}; set typescript.tsdk to the project's TypeScript ${TS_VERSION}.`);
    return null;
  }
  let projectDir: string;
  let modName: string;
  let profile: ReturnType<typeof loadProfile>;
  try {
    projectDir = findProjectDir(info.project.getCurrentDirectory());
    modName = loadProjectConfig(projectDir).mod.name;
    profile = loadProfile();
  } catch (e) {
    log(`disabled: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  const stubsRoot = join(projectDir, ".abfc", "stubs");
  const isStub = (fileName: string): boolean => {
    if (!fileName.endsWith(".d.ts")) return false;
    const rel = relative(stubsRoot, fileName);
    return rel !== "" && !rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel);
  };

  // The manifest token, cached for a second.
  let token = "";
  let tokenAt = -Infinity;
  const currentToken = (): string => {
    const now = Date.now();
    if (now - tokenAt >= TOKEN_TTL_MS) {
      token = manifestToken(projectDir);
      tokenAt = now;
    }
    return token;
  };

  // The owned-manual filter, rebuilt when the token changes.
  let filterToken: string | null = null;
  let filter: ((fileName: string, text: string) => string) | null = null;
  const currentFilter = (): ((fileName: string, text: string) => string) | null => {
    const t = currentToken();
    if (filterToken !== t) {
      filter = ownedManualFilter(projectDir, (file, why) => log(`ignoring unreadable ${file}: ${why}`));
      filterToken = t;
    }
    return filter;
  };

  const host = info.languageServiceHost;
  const getScriptSnapshot = host.getScriptSnapshot.bind(host);
  const getScriptVersion = host.getScriptVersion.bind(host);
  host.getScriptSnapshot = (fileName: string): ts.IScriptSnapshot | undefined => {
    const snap = getScriptSnapshot(fileName);
    if (snap === undefined || !isStub(fileName)) return snap;
    const f = currentFilter();
    if (f === null) return snap;
    const text = snap.getText(0, snap.getLength());
    if (!text.includes("@bpHandMade")) return snap;
    const out = f(fileName, text);
    return out === text ? snap : tsMod.ScriptSnapshot.fromString(out);
  };
  host.getScriptVersion = (fileName: string): string => {
    const v = getScriptVersion(fileName);
    return isStub(fileName) ? `${v}:${currentToken()}` : v;
  };

  const cache = new WeakMap<ts.Program, { loaded: LoadedProgram; check: ProjectCheck }>();
  const checkOf = (program: ts.Program): { loaded: LoadedProgram; check: ProjectCheck } => {
    let entry = cache.get(program);
    if (entry === undefined) {
      const loaded = loadedFromProgram(projectDir, program, tsDiagnostics(program, projectDir));
      entry = { loaded, check: checkProject(loaded, { mod: modName }, profile) };
      cache.set(program, entry);
    }
    return entry;
  };

  // The token the current program was (or is about to be) built with. tsserver does not look at the changed script versions while
  // the project version is unchanged, so a changed token has to mark the project dirty.
  let seenToken = currentToken();
  const sync = (): void => {
    const t = currentToken();
    if (t === seenToken) return;
    seenToken = t;
    info.project.markAsDirty?.();
  };

  const programAndFile = (fileName: string): { program: ts.Program; sf: ts.SourceFile } | undefined => {
    sync();
    const program = info.languageService.getProgram();
    const sf = program?.getSourceFile(fileName);
    return program === undefined || sf === undefined ? undefined : { program, sf };
  };

  const action = (fileName: string, fixName: string, description: string, edits: TextEdit[]): ts.CodeFixAction => ({
    fixName,
    description,
    changes: [{ fileName, textChanges: edits.map((e) => ({ span: { start: e.start, length: e.length }, newText: e.newText })) }],
  });

  return {
    sync,

    diagnostics(fileName) {
      const at = programAndFile(fileName);
      if (at === undefined) return [];
      const rel = relFile(projectDir, at.sf.fileName);
      const out: ts.Diagnostic[] = [];
      for (const d of checkOf(at.program).check.diagnostics) {
        if (d.span === undefined || d.span.file !== rel) continue;
        const start = at.sf.getPositionOfLineAndCharacter(d.span.line - 1, d.span.col - 1);
        const end = at.sf.getPositionOfLineAndCharacter(d.span.endLine - 1, d.span.endCol - 1);
        out.push({
          file: at.sf,
          start,
          length: Math.max(0, end - start),
          category: d.severity === "error" ? tsMod.DiagnosticCategory.Error : tsMod.DiagnosticCategory.Warning,
          code: Number(d.code.slice(4)),
          source: "abfc",
          messageText: `${d.code}: ${d.message}`,
        });
      }
      return out;
    },

    quickInfo(fileName, position, base) {
      const at = programAndFile(fileName);
      if (at === undefined) return base;
      const ir = checkOf(at.program).check.ir;
      if (ir === null) return base;
      const lc = at.sf.getLineAndCharacterOfPosition(position);
      const nodes = irNodesAt(ir, relFile(projectDir, at.sf.fileName), lc.line + 1, lc.character + 1);
      if (nodes.length === 0) return base;
      const texts = [...new Set(nodes.map(describeIrNode))];
      const shown = texts.slice(0, MAX_HOVER_NODES);
      const more = texts.length - shown.length;
      const line = `Blueprint: ${shown.join(" · ")}${more > 0 ? ` (+${more} more)` : ""}`;
      if (base === undefined) {
        return {
          kind: "" as ts.ScriptElementKind,
          kindModifiers: "",
          textSpan: { start: position, length: 1 },
          documentation: [{ text: line, kind: "text" }],
        };
      }
      const docs = base.documentation ?? [];
      return {
        ...base,
        documentation: docs.length > 0 ? [...docs, { text: "\n", kind: "lineBreak" }, { text: line, kind: "text" }] : [{ text: line, kind: "text" }],
      };
    },

    codeFixes(fileName, start, end, errorCodes, base) {
      const wantsIdiv = errorCodes.some((c) => IDIV_CODES.includes(c));
      const wantsChain = errorCodes.some((c) => OPTIONAL_CHAIN_CODES.includes(c));
      if (!wantsIdiv && !wantsChain) return base;
      const at = programAndFile(fileName);
      if (at === undefined) return base;
      const extra: ts.CodeFixAction[] = [];
      if (wantsIdiv) {
        const edits = idivFix(at.sf, start, end);
        if (edits !== undefined) extra.push(action(fileName, "abfcIdiv", "Use idiv(a, b) (Blueprint Divide_IntInt)", edits));
      }
      if (wantsChain) {
        const edits = optionalChainFix(at.sf, start, end);
        if (edits !== undefined) extra.push(action(fileName, "abfcOptionalChain", "Use ?. (lowers to IsValid + Branch)", edits));
      }
      return extra.length === 0 ? base : [...base, ...extra];
    },

    supportedCodeFixes(base) {
      const all = new Set(base);
      for (const c of [...IDIV_CODES, ...OPTIONAL_CHAIN_CODES]) all.add(String(c));
      return [...all];
    },
  };
}
