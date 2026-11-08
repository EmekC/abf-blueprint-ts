// Editor completions that TypeScript alone does not give for stubs: static library functions anywhere (with the import) and
// overridable parent events as ready-made `@override override Name(): void { }` stubs inside a class body. Pure over the loaded
// program, so the language server and the tests share it; offsets are UTF-16 string offsets of the file text.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { runtimeBinding } from "./fixes.js";
import type { LoadedProgram } from "./program.js";
import { functionInfo } from "./tags.js";

export interface AbfcCompletion {
  label: string;
  kind: "function" | "method";
  detail: string;
  documentation?: string;
  insertText: string;
  /** `insertText` is an LSP snippet (`$0` marks the cursor; `$`, `}` and `\` are escaped). */
  snippet: boolean;
  /** The text range (the word under the cursor) that `insertText` replaces. */
  replace: { start: number; end: number };
  /** Further edits (imports); never overlap `replace`. */
  additionalEdits: Array<{ start: number; end: number; newText: string }>;
  sortText: string;
  /** Text the client filters on; the label when absent. */
  filterText?: string;
  /** Shown next to the label, e.g. `KismetSystemLibrary · Set Timer by Event`. */
  labelDescription?: string;
}

export interface LibraryEntry {
  name: string;
  /** The namespace the function is declared in, e.g. `KismetSystemLibrary`. */
  container: string;
  /** The import specifier of the stub file, e.g. `/Script/Engine`. */
  module: string;
  /** `(InString?: string): void` */
  signature: string;
  doc: string;
  /** The Blueprint node name from the description's `(...)`, e.g. `Set Timer by Event`; absent in stubs without one. */
  displayName?: string;
}

const MAX_LIBRARY_ITEMS = 100;
const LOCK_FILE = "stubs.lock.json";
const RUNTIME_MODULE = "@abfc/runtime";

const fwd = (p: string): string => p.replaceAll("\\", "/");

/** Import specifier of a stub file from its path relative to the profile folder (`Script/Engine` -> `/Script/Engine`, `Mod/<mod>/UI/W` -> `@mod/UI/W`). */
function moduleOfRelative(rel: string): string | undefined {
  const p = fwd(rel).replace(/\.d\.ts$/i, "");
  if (/^Script\/./.test(p)) return `/${p}`;
  if (/^Game\/./.test(p)) return `/${p}`;
  const m = /^Mod\/[^/]+\/(.+)$/.exec(p);
  return m === null ? undefined : `@mod/${m[1]}`;
}

/** Import specifier of an absolute stub file path under `.abfc/stubs/<profile>/`. */
function moduleOfStubPath(fileName: string): string | undefined {
  const m = /\/\.abfc\/stubs\/[^/]+\/(.+\.d\.ts)$/i.exec(fwd(fileName));
  return m === null ? undefined : moduleOfRelative(m[1] ?? "");
}

function docOf(node: ts.Node): string {
  const parts: string[] = [];
  for (const d of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(d) && d.comment !== undefined) parts.push(ts.getTextOfJSDocComment(d.comment) ?? "");
  }
  return parts.join("\n").trim();
}

/** `(params): ret` of a declaration, as shown in a completion's detail. */
function signatureOf(decl: ts.SignatureDeclaration, sf: ts.SourceFile): string {
  const params = decl.parameters.map((p) => p.getText(sf)).join(", ");
  return `(${params}): ${decl.type === undefined ? "void" : decl.type.getText(sf)}`;
}

/**
 * The Blueprint node name stubgen writes at the end of a function description, `Starts a timer (Set Timer by Event).` ->
 * `Set Timer by Event`; undefined when the first line does not end in a balanced `(...)`.
 */
export function displayNameFromDoc(doc: string): string | undefined {
  const first = doc.split(/\r?\n/).find((l) => l.trim() !== "");
  if (first === undefined) return undefined;
  let line = first.trim();
  if (line.endsWith(".")) line = line.slice(0, -1);
  if (!line.endsWith(")")) return undefined;
  let depth = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    const c = line[i];
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) {
        const inside = line.slice(i + 1, line.length - 1).trim();
        return inside === "" ? undefined : inside;
      }
    }
  }
  return undefined;
}

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);
const isUpper = (c: string | undefined): boolean => c !== undefined && /[A-Z]/.test(c);
const isLower = (c: string | undefined): boolean => c !== undefined && /[a-z]/.test(c);
const isDigit = (c: string | undefined): boolean => c !== undefined && /[0-9]/.test(c);
const isLetter = (c: string | undefined): boolean => isUpper(c) || isLower(c);

/** Indexes (>= 1) in `s` where a word begins: after a separator, at a camel hump, at an acronym end (`HUDClass` -> `Class`) or at a digit run. */
function wordStarts(s: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    const p = s[i - 1];
    const n = s[i + 1];
    if (
      (isAlnum(c) && !isAlnum(p)) ||
      (isUpper(c) && (isLower(p) || isDigit(p))) ||
      (isUpper(c) && isUpper(p) && isLower(n)) ||
      (isDigit(c) && isLetter(p))
    ) {
      out.push(i);
    }
  }
  return out;
}

const squash = (s: string): string => s.replace(/[^A-Za-z0-9_$]/g, "");

/** Typed characters needed before display-name and word-start matches count. */
export const MIN_WORD_MATCH = 3;

export interface NameMatch {
  /** 0 full-name prefix, 1 prefix of the name without `K2_`/`BP_`, 2 prefix of the node name, 3 word start inside the name or node name. */
  tier: 0 | 1 | 2 | 3;
  /** The matched text from the match point on (what a client should filter on). */
  filterText: string;
}

/** How `prefix` (case-insensitive) matches a function name or its Blueprint node name, best tier first; undefined when it does not. */
export function matchName(name: string, displayName: string | undefined, prefix: string): NameMatch | undefined {
  const q = prefix.toLowerCase();
  if (q === "") return undefined;
  if (name.toLowerCase().startsWith(q)) return { tier: 0, filterText: name };
  const stripped = name.replace(/^(K2|BP)_/, "");
  if (stripped !== name && stripped.toLowerCase().startsWith(q)) return { tier: 1, filterText: stripped };
  if (q.length < MIN_WORD_MATCH) return undefined;
  const d = displayName === undefined ? "" : squash(displayName);
  if (d !== "" && d.toLowerCase().startsWith(q)) return { tier: 2, filterText: d };
  for (const i of wordStarts(name)) {
    const rest = name.slice(i);
    if (rest.toLowerCase().startsWith(q)) return { tier: 3, filterText: rest };
  }
  if (displayName !== undefined) {
    for (const i of wordStarts(displayName)) {
      const rest = squash(displayName.slice(i));
      if (rest.toLowerCase().startsWith(q)) return { tier: 3, filterText: rest };
    }
  }
  return undefined;
}

function* dtsFiles(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* dtsFiles(full);
    else if (e.isFile() && e.name.endsWith(".d.ts")) yield full;
  }
}

const indexCache = new Map<string, { mtimeMs: number; entries: LibraryEntry[] }>();

/**
 * Every static function of every `export declare namespace X { function F }` in a stubs profile folder (`.abfc/stubs/<profile>`),
 * independent of what a file imports. Cached per folder while `stubs.lock.json` keeps its modification time.
 */
export function buildLibraryIndex(stubsProfileDir: string): LibraryEntry[] {
  const dir = resolve(stubsProfileDir);
  const lock = join(dir, LOCK_FILE);
  const mtimeMs = existsSync(lock) ? statSync(lock).mtimeMs : -1;
  const cached = indexCache.get(dir);
  if (mtimeMs >= 0 && cached !== undefined && cached.mtimeMs === mtimeMs) return cached.entries;

  const entries: LibraryEntry[] = [];
  for (const file of dtsFiles(dir)) {
    const module = moduleOfRelative(relative(dir, file));
    if (module === undefined) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("namespace ")) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isModuleDeclaration(st) || !ts.isIdentifier(st.name) || st.body === undefined || !ts.isModuleBlock(st.body)) continue;
      if (!(ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Export)) continue;
      for (const inner of st.body.statements) {
        if (!ts.isFunctionDeclaration(inner) || inner.name === undefined) continue;
        if (ts.getJSDocDeprecatedTag(inner) !== undefined) continue;
        const doc = docOf(inner);
        const displayName = displayNameFromDoc(doc);
        entries.push({
          name: inner.name.text,
          container: st.name.text,
          module,
          signature: signatureOf(inner, sf),
          doc,
          ...(displayName === undefined ? {} : { displayName }),
        });
      }
    }
  }
  if (mtimeMs >= 0) indexCache.set(dir, { mtimeMs, entries });
  return entries;
}

const isIdChar = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;

function findSource(loaded: LoadedProgram, fileName: string): ts.SourceFile | undefined {
  const direct = loaded.program.getSourceFile(fileName);
  if (direct !== undefined) return direct;
  const want = fwd(resolve(fileName)).toLowerCase();
  return loaded.program.getSourceFiles().find((f) => fwd(resolve(f.fileName)).toLowerCase() === want);
}

const isJsDoc = (n: ts.Node): boolean => n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode;

/** The nodes from the file down to the innermost token (or childless node) whose range ends at or after `pos` and starts before it; SyntaxLists left out. */
function chainAt(sf: ts.SourceFile, pos: number): ts.Node[] {
  const chain: ts.Node[] = [];
  let node: ts.Node = sf;
  for (;;) {
    if (node.kind !== ts.SyntaxKind.SyntaxList) chain.push(node);
    let next: ts.Node | undefined;
    for (const c of node.getChildren(sf)) {
      if (isJsDoc(c)) continue;
      if (c.getFullStart() < pos && pos <= c.getEnd()) {
        next = c;
        break;
      }
    }
    if (next === undefined) return chain;
    node = next;
  }
}

/** True when `pos` is inside a comment in the trivia in front of `leaf`. */
function inComment(sf: ts.SourceFile, leaf: ts.Node, pos: number): boolean {
  const from = leaf.getFullStart();
  const to = leaf.getStart(sf);
  if (pos <= from || pos > to) return false;
  const sc = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sf.text);
  sc.setTextPos(from);
  for (;;) {
    const k = sc.scan();
    const s = sc.getTokenStart();
    const e = sc.getTokenEnd();
    if (k === ts.SyntaxKind.EndOfFileToken || s >= to) return false;
    if (k === ts.SyntaxKind.SingleLineCommentTrivia && s < pos && pos <= e) return true;
    if (k === ts.SyntaxKind.MultiLineCommentTrivia) {
      const closed = e - s >= 4 && sf.text.slice(e - 2, e) === "*/";
      if (s < pos && (closed ? pos < e : pos <= e)) return true;
    }
  }
}

/** True when `pos` is inside the text of a string, template or regular expression token. */
function inLiteral(sf: ts.SourceFile, leaf: ts.Node, pos: number): boolean {
  const s = leaf.getStart(sf);
  const e = leaf.getEnd();
  if (pos <= s) return false;
  switch (leaf.kind) {
    case ts.SyntaxKind.StringLiteral: {
      const closed = e - s >= 2 && sf.text[e - 1] === sf.text[s];
      return closed ? pos < e : pos <= e;
    }
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral: {
      const closed = e - s >= 2 && sf.text[e - 1] === "`";
      return closed ? pos < e : pos <= e;
    }
    case ts.SyntaxKind.TemplateHead:
    case ts.SyntaxKind.TemplateMiddle:
      return pos <= e - 2;
    case ts.SyntaxKind.TemplateTail:
      return pos < e;
    case ts.SyntaxKind.RegularExpressionLiteral:
      return pos < e;
    default:
      return false;
  }
}

type Edit = { start: number; end: number; newText: string };

interface ImportWant {
  module: string;
  name: string;
  /** A type: goes to an `import type { }`. Otherwise a value import. */
  type: boolean;
}

/**
 * Edits that make `wants` importable: the name is appended to an existing named import of the module (type names only to a
 * type-only import, values only to a value import), else a new line after the last import (a file without imports gets the lines
 * in front of its first statement).
 */
function planImports(sf: ts.SourceFile, wants: ImportWant[]): Edit[] {
  const nl = sf.text.includes("\r\n") ? "\r\n" : "\n";
  const edits: Edit[] = [];
  const newLines: string[] = [];
  const groups = new Map<string, { module: string; type: boolean; names: string[] }>();
  for (const w of wants) {
    const key = `${w.type ? "t" : "v"}\0${w.module}`;
    const g = groups.get(key) ?? { module: w.module, type: w.type, names: [] };
    if (!g.names.includes(w.name)) g.names.push(w.name);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    let appendAfter: ts.ImportSpecifier | undefined;
    let emptyBraces: ts.NamedImports | undefined;
    const present = new Set<string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== g.module) continue;
      const clause = st.importClause;
      const named = clause?.namedBindings;
      if (clause === undefined || named === undefined || !ts.isNamedImports(named)) continue;
      for (const el of named.elements) present.add((el.propertyName ?? el.name).text);
      if (clause.isTypeOnly !== g.type) continue;
      const last = named.elements[named.elements.length - 1];
      if (last !== undefined) appendAfter ??= last;
      else emptyBraces ??= named;
    }
    const names = g.names.filter((n) => !present.has(n));
    if (names.length === 0) continue;
    if (appendAfter !== undefined) {
      edits.push({ start: appendAfter.getEnd(), end: appendAfter.getEnd(), newText: `, ${names.join(", ")}` });
    } else if (emptyBraces !== undefined) {
      const at = emptyBraces.getStart(sf) + 1;
      edits.push({ start: at, end: at, newText: ` ${names.join(", ")} ` });
    } else {
      newLines.push(`import ${g.type ? "type " : ""}{ ${names.join(", ")} } from "${g.module}";`);
    }
  }
  if (newLines.length > 0) {
    const imports = sf.statements.filter((s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s));
    const lastImport = imports[imports.length - 1];
    if (lastImport !== undefined) {
      edits.push({ start: lastImport.getEnd(), end: lastImport.getEnd(), newText: newLines.map((l) => nl + l).join("") });
    } else {
      const first = sf.statements[0];
      const at = first === undefined ? 0 : first.getStart(sf);
      edits.push({ start: at, end: at, newText: newLines.map((l) => l + nl).join("") });
    }
  }
  return edits;
}

/** Joins insertions at the same offset (client order of equal-position edits is not reliable) and sorts by offset. */
function mergeEdits(edits: Edit[]): Edit[] {
  const out: Edit[] = [];
  for (const e of edits) {
    const same = e.start === e.end ? out.find((o) => o.start === e.start && o.end === o.start) : undefined;
    if (same !== undefined) same.newText += e.newText;
    else out.push({ ...e });
  }
  return out.sort((a, b) => a.start - b.start);
}

const KIND_SCOPE = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias;

function namesInScope(loaded: LoadedProgram, at: ts.Node): Set<string> {
  try {
    return new Set(loaded.checker.getSymbolsInScope(at, KIND_SCOPE).map((s) => s.name));
  } catch {
    return new Set();
  }
}

const snippetEscape = (s: string): string => s.replace(/[\\$}]/g, (c) => `\\${c}`);

function classLike(n: ts.Node): n is ts.ClassLikeDeclaration {
  return ts.isClassDeclaration(n) || ts.isClassExpression(n);
}

/** Left-most identifiers of the type references in a type node. */
function typeNamesOf(node: ts.Node, out: Set<string>): void {
  if (ts.isTypeReferenceNode(node)) {
    let n: ts.EntityName = node.typeName;
    while (ts.isQualifiedName(n)) n = n.left;
    out.add(n.text);
  }
  ts.forEachChild(node, (c) => typeNamesOf(c, out));
}

/** The module a type name used in a stub declaration comes from: the stub file's import of it, or the stub file itself. */
function moduleOfStubType(stubSf: ts.SourceFile, name: string): string | undefined {
  for (const st of stubSf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    if (named.elements.some((el) => el.name.text === name)) return st.moduleSpecifier.text;
  }
  const local = stubSf.statements.some(
    (st) =>
      (ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name,
  );
  return local ? moduleOfStubPath(stubSf.fileName) : undefined;
}

const EVENT_NAME = /^(Receive|K2_On|BP_On|OnReceive)[A-Z0-9_]/;

/** Decision 5 rule: a parent instance method that is a plausible overridable event. */
function isOverridableEvent(sym: ts.Symbol, decl: ts.MethodDeclaration | ts.MethodSignature, doc: string): boolean {
  const info = functionInfo(sym);
  if (info === undefined || info.static || info.pure) return false;
  if (decl.type?.kind !== ts.SyntaxKind.VoidKeyword) return false;
  if (ts.getJSDocDeprecatedTag(decl) !== undefined) return false;
  if (!info.owner.startsWith("/Script/")) return true;
  if (EVENT_NAME.test(info.name)) return true;
  const first = doc.split(/\r?\n/).find((l) => l.trim() !== "");
  return first !== undefined && /^Event\b/.test(first.trim());
}

function overrideCompletions(
  loaded: LoadedProgram,
  sf: ts.SourceFile,
  cls: ts.ClassLikeDeclaration,
  prefix: string,
  replace: { start: number; end: number },
): AbfcCompletion[] {
  const { checker } = loaded;
  const classType = checker.getTypeAtLocation(cls);
  const bases = checker.getBaseTypes(classType as ts.InterfaceType);
  const parent = bases[0];
  if (parent === undefined) return [];

  const declared = new Set<string>();
  for (const m of cls.members) {
    if (m.name !== undefined && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) declared.add(m.name.text);
  }
  const scope = namesInScope(loaded, cls);
  const wantPrefix = prefix.toLowerCase();
  const out: AbfcCompletion[] = [];
  for (const sym of checker.getPropertiesOfType(parent)) {
    if (!(sym.flags & ts.SymbolFlags.Method) || declared.has(sym.name)) continue;
    if (sym.name === "UserConstructionScript") continue; // Unreal refuses it as an event node (ABFC2083)
    if (wantPrefix !== "" && !sym.name.toLowerCase().includes(wantPrefix)) continue;
    const decl = (sym.declarations ?? []).find((d): d is ts.MethodDeclaration | ts.MethodSignature => ts.isMethodDeclaration(d) || ts.isMethodSignature(d));
    if (decl === undefined) continue;
    const doc = ts.displayPartsToString(sym.getDocumentationComment(checker));
    if (!isOverridableEvent(sym, decl, doc)) continue;

    const stubSf = decl.getSourceFile();
    const params = decl.parameters.map((p) => p.getText(stubSf)).join(", ");
    const typeNames = new Set<string>();
    for (const p of decl.parameters) if (p.type !== undefined) typeNamesOf(p.type, typeNames);
    const wants: ImportWant[] = [];
    for (const tn of typeNames) {
      if (scope.has(tn)) continue;
      const module = moduleOfStubType(stubSf, tn);
      if (module !== undefined) wants.push({ module, name: tn, type: true });
    }
    const edits: Edit[] = planImports(sf, wants);
    const binding = runtimeBinding(sf, "override");
    if (binding.edit !== undefined) edits.push({ start: binding.edit.start, end: binding.edit.start + binding.edit.length, newText: binding.edit.newText });

    out.push({
      label: sym.name,
      kind: "method",
      detail: `override ${sym.name}(${params}): void`,
      ...(doc === "" ? {} : { documentation: doc }),
      insertText: `@${binding.name} override ${sym.name}(${snippetEscape(params)}): void {\n\t$0\n}`,
      snippet: true,
      replace,
      additionalEdits: mergeEdits(edits),
      sortText: `0${sym.name}`,
    });
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** The name `container` is callable under from this file when it is already imported from `module` as a value. */
function importedContainer(sf: ts.SourceFile, container: string, module: string): string | undefined {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== module) continue;
    const clause = st.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    const named = clause.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    const el = named.elements.find((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === container);
    if (el !== undefined) return el.name.text;
  }
  return undefined;
}

function libraryCompletions(
  loaded: LoadedProgram,
  sf: ts.SourceFile,
  at: ts.Node,
  prefix: string,
  replace: { start: number; end: number },
  index: LibraryEntry[],
): AbfcCompletion[] {
  const hits = index.flatMap((e) => {
    const m = matchName(e.name, e.displayName, prefix);
    return m === undefined ? [] : [{ e, m }];
  });
  hits.sort((a, b) => {
    if (a.m.tier !== b.m.tier) return a.m.tier - b.m.tier;
    if (a.m.tier === 0) {
      const ca = a.e.name.startsWith(prefix) ? 0 : 1;
      const cb = b.e.name.startsWith(prefix) ? 0 : 1;
      if (ca !== cb) return ca - cb;
    }
    const an = a.e.name;
    const bn = b.e.name;
    return an < bn ? -1 : an > bn ? 1 : a.e.container < b.e.container ? -1 : a.e.container > b.e.container ? 1 : 0;
  });
  const scope = namesInScope(loaded, at);
  const out: AbfcCompletion[] = [];
  for (const { e, m } of hits) {
    if (out.length >= MAX_LIBRARY_ITEMS) break;
    let local = importedContainer(sf, e.container, e.module);
    let edits: Edit[] = [];
    if (local === undefined) {
      if (scope.has(e.container)) continue; // bound to something else here
      local = e.container;
      edits = planImports(sf, [{ module: e.module, name: e.container, type: false }]);
    }
    let insertText = `${local}.${e.name}`;
    let additionalEdits = mergeEdits(edits);
    // An import in front of the first statement would touch the replaced word: fold it into the inserted text instead.
    const touching = additionalEdits.find((x) => x.start === replace.start && x.end === x.start);
    if (touching !== undefined) {
      insertText = touching.newText + insertText;
      additionalEdits = additionalEdits.filter((x) => x !== touching);
    }
    out.push({
      label: e.name,
      kind: "function",
      detail: `${e.container}.${e.name}${e.signature}`,
      ...(e.doc === "" ? {} : { documentation: e.doc }),
      insertText,
      snippet: false,
      replace,
      additionalEdits,
      sortText: `1${"ABCD"[m.tier]}${e.name}`,
      filterText: m.filterText,
      labelDescription: e.displayName === undefined ? e.container : `${e.container} · ${e.displayName}`,
    });
  }
  return out;
}

/**
 * After `x.`: stub members whose Blueprint node name matches the typed prefix but whose C++ name does not (the TypeScript server
 * already lists the others).
 */
function memberCompletions(loaded: LoadedProgram, access: ts.PropertyAccessExpression, prefix: string, replace: { start: number; end: number }): AbfcCompletion[] {
  if (prefix.length < MIN_WORD_MATCH) return [];
  const { checker } = loaded;
  let props: ts.Symbol[];
  try {
    props = checker.getPropertiesOfType(checker.getTypeAtLocation(access.expression));
  } catch {
    return [];
  }
  const hits: Array<{ item: AbfcCompletion; tier: number }> = [];
  for (const sym of props) {
    if (!(sym.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Function))) continue;
    const decl = (sym.declarations ?? []).find((d): d is ts.MethodDeclaration | ts.MethodSignature | ts.FunctionDeclaration => ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isFunctionDeclaration(d));
    if (decl === undefined) continue;
    if (moduleOfStubPath(decl.getSourceFile().fileName) === undefined) continue;
    if (ts.getJSDocDeprecatedTag(decl) !== undefined) continue;
    if (matchName(sym.name, undefined, prefix) !== undefined) continue;
    const doc = docOf(decl);
    const display = displayNameFromDoc(doc);
    if (display === undefined) continue;
    const m = matchName(sym.name, display, prefix);
    if (m === undefined) continue;
    hits.push({
      tier: m.tier,
      item: {
        label: sym.name,
        kind: ts.isFunctionDeclaration(decl) ? "function" : "method",
        detail: sym.name + signatureOf(decl, decl.getSourceFile()),
        ...(doc === "" ? {} : { documentation: doc }),
        insertText: sym.name,
        snippet: false,
        replace,
        additionalEdits: [],
        sortText: `1${"ABCD"[m.tier]}${sym.name}`,
        filterText: m.filterText,
        labelDescription: display,
      },
    });
  }
  hits.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : a.item.label < b.item.label ? -1 : a.item.label > b.item.label ? 1 : 0));
  return hits.slice(0, MAX_LIBRARY_ITEMS).map((h) => h.item);
}

/** True when the identifier is a declaration's name (a parameter, variable, member, ...), where no expression is written. */
function isDeclarationName(id: ts.Node, parent: ts.Node): boolean {
  return (parent as { name?: ts.Node }).name === id;
}

/**
 * Completions at `pos` of `fileName`: none in comments, strings, imports or after `@`; after `.` only stub members found by their
 * Blueprint node name; in a class body at a member start the overridable parent events; in a statement or expression the library
 * functions matching the typed prefix (C++ name with or without `K2_`/`BP_`, a word of it, or the Blueprint node name).
 */
export function completionsAt(loaded: LoadedProgram, fileName: string, pos: number, index: LibraryEntry[]): AbfcCompletion[] {
  const sf = findSource(loaded, fileName);
  if (sf === undefined) return [];
  const text = sf.text;
  if (pos < 0 || pos > text.length) return [];

  let start = pos;
  while (start > 0 && isIdChar(text.charCodeAt(start - 1))) start--;
  let end = pos;
  while (end < text.length && isIdChar(text.charCodeAt(end))) end++;
  const prefix = text.slice(start, pos);
  if (/^[0-9]/.test(prefix)) return [];
  const replace = { start, end };

  // a member access (`x.`, `x?.`) or a decorator name (`@`) is not ours
  let k = start - 1;
  while (k >= 0 && /\s/.test(text[k] ?? "")) k--;
  const prevCh = k >= 0 ? text[k] : "";
  if (prevCh === "@") return [];
  const afterDot = prevCh === "." && !(k >= 2 && text.slice(k - 2, k + 1) === "...");

  const chain = chainAt(sf, pos);
  const leaf = chain[chain.length - 1];
  if (leaf === undefined || leaf === sf) return [];
  if (inComment(sf, leaf, pos) || inLiteral(sf, leaf, pos)) return [];
  if (chain.some((n) => ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n) || ts.isExportAssignment(n))) return [];

  // after `.`: only members found by their Blueprint node name
  if (afterDot) {
    const parent = chain[chain.length - 2];
    if (leaf.kind !== ts.SyntaxKind.Identifier || parent === undefined || !ts.isPropertyAccessExpression(parent) || parent.name !== leaf) return [];
    return memberCompletions(loaded, parent, prefix, replace);
  }

  // class body: member start
  let ci = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = chain[i];
    if (n !== undefined && classLike(n)) {
      ci = i;
      break;
    }
  }
  if (ci >= 0) {
    const cls = chain[ci] as ts.ClassLikeDeclaration;
    const next = chain[ci + 1];
    let memberStart = false;
    if (next !== undefined) {
      if (prefix === "") {
        if (ts.isClassElement(next) || next.kind === ts.SyntaxKind.CloseBraceToken) memberStart = pos <= next.getStart(sf);
        else if (next.kind === ts.SyntaxKind.OpenBraceToken) memberStart = pos === next.getEnd();
      } else if (ts.isPropertyDeclaration(next)) {
        memberStart = next.getStart(sf) === start && chain[ci + 2] === next.name && next.type === undefined && next.initializer === undefined;
      }
    }
    if (memberStart) return overrideCompletions(loaded, sf, cls, prefix, replace);
  }

  // statement or expression
  if (prefix === "") return [];
  if (leaf.kind !== ts.SyntaxKind.Identifier) return [];
  const parent = chain[chain.length - 2];
  if (parent === undefined) return [];
  if (chain.some((n) => ts.isTypeNode(n))) return [];
  if (isDeclarationName(leaf, parent)) return [];
  if (ts.isDecorator(parent) || (ts.isCallExpression(parent) && parent.expression === leaf && ts.isDecorator(chain[chain.length - 3] ?? parent.parent))) return [];
  if (ts.isQualifiedName(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return [];
  return libraryCompletions(loaded, sf, leaf, prefix, replace, index);
}
