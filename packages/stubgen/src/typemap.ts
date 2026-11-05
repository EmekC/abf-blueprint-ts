// bp_apply type grammar <-> TypeScript type text for stubs.
import type { ReflectPin } from "./types.js";
import { UOBJECT_PATH } from "./names.js";

export type RuntimeName =
  | "int" | "int64" | "byte" | "float" | "double" | "name" | "text" | "TSubclassOf" | "TSoftObjectPtr" | "TSoftClassPtr";

export const RUNTIME_NAMES: readonly RuntimeName[] = [
  "int", "int64", "byte", "float", "double", "name", "text", "TSubclassOf", "TSoftObjectPtr", "TSoftClassPtr",
];

export interface TypeRef {
  path: string;
  kind: "class" | "struct" | "enum";
}

/** Resolves a referenced type to the local name used in the file (and registers its import). */
export interface TypeCtx {
  ref(path: string, kind: TypeRef["kind"]): string;
  runtime(name: RuntimeName): string;
}

const PATH_KINDS = ["object", "class", "softobject", "softclass", "interface", "struct"] as const;

/**
 * Grammar string of a reflected pin: the bp_apply grammar for supported types, `wildcard` / `array:wildcard` for generic
 * pins, and `unsupported:<category>[:<container>]` for the rest (maps, sets, delegates, ...).
 */
export function grammarOfPin(p: Pick<ReflectPin, "category" | "subCategory" | "subCategoryObject" | "container">): string {
  const container = p.container === "" ? "None" : p.container;
  if (container !== "None" && container !== "Array") return `unsupported:${p.category}:${container}`;
  const path = p.subCategoryObject;
  let inner: string;
  switch (p.category) {
    case "bool": case "int": case "int64": case "name": case "string": case "text": case "exec": case "wildcard":
      inner = p.category;
      break;
    case "float": case "double":
      inner = p.category;
      break;
    case "real":
      inner = p.subCategory === "float" ? "float" : "real";
      break;
    case "byte":
      inner = path ? `enum:${path}` : "byte";
      break;
    case "object": case "class":
      inner = `${p.category}:${path ?? UOBJECT_PATH}`;
      break;
    case "softobject": case "softclass": case "interface": case "struct":
      if (!path) return `unsupported:${p.category}${container === "Array" ? ":Array" : ""}`;
      inner = `${p.category}:${path}`;
      break;
    default:
      return `unsupported:${p.category}${container === "Array" ? ":Array" : ""}`;
  }
  return container === "Array" ? `array:${inner}` : inner;
}

function split(g: string): { array: boolean; inner: string } {
  return g.startsWith("array:") ? { array: true, inner: g.slice(6) } : { array: false, inner: g };
}

/** The type paths a grammar string mentions (none for unsupported types). */
export function refsOfGrammar(g: string): TypeRef[] {
  const { inner } = split(g);
  const colon = inner.indexOf(":");
  if (colon < 0) return [];
  const head = inner.slice(0, colon);
  const path = inner.slice(colon + 1);
  if (head === "enum") return [{ path, kind: "enum" }];
  if (head === "struct") return [{ path, kind: "struct" }];
  if ((PATH_KINDS as readonly string[]).includes(head)) return [{ path, kind: "class" }];
  return [];
}

export function isUnsupported(g: string): boolean {
  return split(g).inner.startsWith("unsupported:");
}

/** `<category>[:<container>]` text for an `@bpUnsupported` tag. */
export function unsupportedLabel(g: string): string {
  return split(g).inner.slice("unsupported:".length);
}

interface Mapped {
  ts: string;
  union: boolean;
}

function mapInner(inner: string, ctx: TypeCtx): Mapped {
  const colon = inner.indexOf(":");
  const head = colon < 0 ? inner : inner.slice(0, colon);
  const path = colon < 0 ? "" : inner.slice(colon + 1);
  switch (head) {
    case "bool": return { ts: "boolean", union: false };
    case "string": return { ts: "string", union: false };
    case "int": case "int64": case "byte": case "float": case "double": case "name": case "text":
      return { ts: ctx.runtime(head), union: false };
    case "real": return { ts: ctx.runtime("double"), union: false };
    case "object": case "interface":
      return { ts: `${ctx.ref(path, "class")} | null`, union: true };
    case "class":
      return { ts: `${ctx.runtime("TSubclassOf")}<${ctx.ref(path, "class")}> | null`, union: true };
    case "softobject":
      return { ts: `${ctx.runtime("TSoftObjectPtr")}<${ctx.ref(path, "class")}>`, union: false };
    case "softclass":
      return { ts: `${ctx.runtime("TSoftClassPtr")}<${ctx.ref(path, "class")}>`, union: false };
    case "struct": return { ts: ctx.ref(path, "struct"), union: false };
    case "enum": return { ts: ctx.ref(path, "enum"), union: false };
    default: return { ts: "unknown", union: false };
  }
}

/** TypeScript type text for a grammar string. */
export function tsOfGrammar(g: string, ctx: TypeCtx): string {
  const { array, inner } = split(g);
  const m = mapInner(inner, ctx);
  if (!array) return m.ts;
  return m.union ? `(${m.ts})[]` : `${m.ts}[]`;
}

const SIMPLE_GRAMMAR = new Set(["bool", "int", "int64", "byte", "name", "string", "text", "real", "float", "double", "exec", "wildcard"]);

/** Keeps a supported grammar string as is and turns anything else (maps, sets, unknown categories) into `unsupported:<text>`. */
export function normalizeGrammar(g: string): string {
  const { inner } = split(g);
  const colon = inner.indexOf(":");
  const head = colon < 0 ? inner : inner.slice(0, colon);
  const ok =
    colon < 0
      ? SIMPLE_GRAMMAR.has(inner)
      : head === "unsupported" || ((PATH_KINDS as readonly string[]).includes(head) || head === "enum") && colon < inner.length - 1;
  return ok ? g : `unsupported:${g.replace(/\s+/g, "_")}`;
}
