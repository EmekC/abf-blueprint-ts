// Reads the `@bp*` JSDoc tags of generated stubs (design 5.1) and maps TypeScript types to bp_apply type grammar.
import ts from "typescript";
import type { BpType } from "../hir.js";

/** Tag name without the `@` -> comments, e.g. `bpPath` -> ["/Script/Engine.Actor"]. */
export type Tags = Map<string, string[]>;

export function bpTags(decl: ts.Node): Tags {
  const m: Tags = new Map();
  for (const t of ts.getJSDocTags(decl)) {
    const name = t.tagName.text;
    const text = (ts.getTextOfJSDocComment(t.comment) ?? "").trim();
    const list = m.get(name);
    if (list) list.push(text);
    else m.set(name, [text]);
  }
  return m;
}

/** Tags of every declaration of a symbol (merged declarations contribute together). */
export function bpTagsOfSymbol(sym: ts.Symbol): Tags {
  const m: Tags = new Map();
  for (const d of sym.declarations ?? []) {
    for (const [k, v] of bpTags(d)) {
      const list = m.get(k);
      if (list) list.push(...v);
      else m.set(k, [...v]);
    }
  }
  return m;
}

export function resolveAlias(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol {
  return sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

export function bpPathOf(sym: ts.Symbol): string | undefined {
  return bpTagsOfSymbol(sym).get("bpPath")?.[0];
}

export function bpTypeOfMember(sym: ts.Symbol): string | undefined {
  return bpTagsOfSymbol(sym).get("bpType")?.[0];
}

/** `Owner:Name` -> both halves. */
export function splitMemberPath(path: string): { owner: string; name: string } | undefined {
  const i = path.lastIndexOf(":");
  return i < 0 ? undefined : { owner: path.slice(0, i), name: path.slice(i + 1) };
}

export interface FunctionInfo {
  owner: string;
  name: string;
  pure: boolean;
  static: boolean;
  execOutputs: string[] | null;
  params: Array<{ tsName: string; pin: string; type: BpType }>;
  outs: Array<{ pin: string; type: BpType }>;
  /** TS name -> real pin name for renamed pins (`@bpPin`). */
  pinOfTs: Map<string, string>;
}

function firstWord(s: string): { head: string; rest: string } {
  const i = s.search(/\s/);
  return i < 0 ? { head: s, rest: "" } : { head: s.slice(0, i), rest: s.slice(i + 1).trim() };
}

/** Function metadata from `@bpPath <class>:<fn>`, `@bpPure`, `@bpExecOutputs`, `@bpParam`, `@bpOut`, `@bpPin`; undefined without `@bpPath`. */
export function functionInfo(sym: ts.Symbol): FunctionInfo | undefined {
  const tags = bpTagsOfSymbol(sym);
  const mp = splitMemberPath(tags.get("bpPath")?.[0] ?? "");
  if (!mp) return undefined;
  const decl = (sym.declarations ?? []).find(
    (d): d is ts.MethodDeclaration | ts.MethodSignature | ts.FunctionDeclaration =>
      ts.isMethodDeclaration(d) || ts.isMethodSignature(d) || ts.isFunctionDeclaration(d),
  );
  const tsNames = decl ? decl.parameters.map((p) => p.name.getText()) : [];
  const params = (tags.get("bpParam") ?? []).map((t, i) => {
    const { head, rest } = firstWord(t);
    return { tsName: tsNames[i] ?? head, pin: head, type: rest };
  });
  const outs = (tags.get("bpOut") ?? []).map((t) => {
    const { head, rest } = firstWord(t);
    return { pin: head, type: rest };
  });
  const pinOfTs = new Map<string, string>();
  for (const t of tags.get("bpPin") ?? []) {
    const { head, rest } = firstWord(t);
    try {
      pinOfTs.set(head, JSON.parse(rest) as string);
    } catch {
      // malformed tag: ignore
    }
  }
  const exec = tags.get("bpExecOutputs")?.[0];
  const isStatic =
    decl !== undefined &&
    (ts.isFunctionDeclaration(decl) ? ts.isModuleBlock(decl.parent) : (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Static) !== 0);
  return {
    owner: mp.owner,
    name: mp.name,
    pure: tags.has("bpPure"),
    static: isStatic,
    execOutputs: exec === undefined ? null : exec.split(",").map((s) => s.trim()).filter((s) => s !== ""),
    params,
    outs,
    pinOfTs,
  };
}

export interface ClassInfo {
  path: string;
  meta: string;
  castPin: string | null;
  kind: "class" | "struct" | "enum";
}

const DEFAULT_META = "/Script/CoreUObject.Class";

/** Class metadata from `@bpPath`, `@bpMeta`, `@bpCastPin`, `@bpKind`; undefined without `@bpPath`. */
export function classInfo(sym: ts.Symbol): ClassInfo | undefined {
  const tags = bpTagsOfSymbol(sym);
  const path = tags.get("bpPath")?.[0];
  if (path === undefined || path === "") return undefined;
  const k = tags.get("bpKind")?.[0];
  return {
    path,
    meta: tags.get("bpMeta")?.[0] ?? DEFAULT_META,
    castPin: tags.get("bpCastPin")?.[0] ?? null,
    kind: k === "struct" ? "struct" : k === "enum" ? "enum" : "class",
  };
}

function literalOfProperty(checker: ts.TypeChecker, type: ts.Type, prop: string): string | undefined {
  const sym = checker.getPropertyOfType(type, prop);
  if (!sym) return undefined;
  const t = checker.getTypeOfSymbol(sym);
  const members = t.isUnion() ? t.types : [t];
  const lit = members.find((m): m is ts.StringLiteralType => m.isStringLiteral());
  return lit?.value;
}

/** Union members without null/undefined (a boolean union stays one member). */
function withoutNullish(checker: ts.TypeChecker, type: ts.Type): ts.Type {
  return checker.getNonNullableType(type);
}

/**
 * Blueprint type of a TypeScript type: flavors (`__bpNumber`, `__bpString`, `__bpEnum`), booleans, Blueprint classes and structs
 * (`@bpPath`), arrays. undefined when the type has no Blueprint meaning (plain `number`, unions of classes, ...).
 */
export function bpTypeOf(checker: ts.TypeChecker, type: ts.Type): BpType | undefined {
  const t = withoutNullish(checker, type);
  if (t.flags & ts.TypeFlags.BooleanLike) return "bool";
  if (checker.isArrayType(t)) {
    const arg = checker.getTypeArguments(t as ts.TypeReference)[0];
    const inner = arg ? bpTypeOf(checker, arg) : undefined;
    return inner === undefined ? undefined : `array:${inner}`;
  }
  const num = literalOfProperty(checker, t, "__bpNumber");
  if (num !== undefined) return num;
  const str = literalOfProperty(checker, t, "__bpString");
  if (str !== undefined) return str;
  const en = literalOfProperty(checker, t, "__bpEnum");
  if (en !== undefined) return `enum:${en}`;
  if (t.flags & ts.TypeFlags.StringLike) return "string";
  const sym = t.getSymbol();
  if (sym) {
    const ci = classInfo(sym);
    if (ci) return ci.kind === "struct" ? `struct:${ci.path}` : ci.kind === "enum" ? `enum:${ci.path}` : `object:${ci.path}`;
  }
  return undefined;
}
