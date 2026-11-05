// Naming rules for generated stubs: identifiers, module specifiers and stub file names.

const RESERVED = new Set([
  "default", "function", "class", "new", "var", "let", "const", "delete", "in", "of", "enum", "export", "import",
  "return", "switch", "case", "this", "super", "type", "void", "with", "yield", "null", "true", "false",
  "string", "number", "boolean", "any", "unknown", "never", "object", "symbol", "bigint", "undefined",
]);

export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const UOBJECT_PATH = "/Script/CoreUObject.Object";

/** Valid TypeScript identifier from arbitrary text (sanitized like the Phase 0 spike generator). */
export function ident(s: string): string {
  let r = s.replace(/[^A-Za-z0-9_$]/g, "_");
  if (r === "") r = "_";
  if (/^[0-9]/.test(r)) r = "_" + r;
  return RESERVED.has(r) ? r + "_" : r;
}

/** Short type name of a class, struct or enum path: the text after the last `.`; `/Script/CoreUObject.Object` is `UObject`. */
export function tsIdent(classPath: string): string {
  if (classPath === UOBJECT_PATH) return "UObject";
  const dot = classPath.lastIndexOf(".");
  return ident(dot < 0 ? classPath.slice(classPath.lastIndexOf("/") + 1) : classPath.slice(dot + 1));
}

/** Module specifier of the stub file that declares `path`: `/Script/M.X` -> `/Script/M`, `/Game/a/b/X.X_C` -> `/Game/a/b/X`. */
export function moduleSpecifier(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? path : path.slice(0, dot);
}

/** Relative file of a module specifier below `.abfc/stubs/<profile>/`. */
export function stubFile(spec: string): string {
  const parts = spec.split("/").filter((p) => p !== "");
  const [head, ...rest] = parts;
  if (head === "Script") return `Script/${rest.join("/")}.d.ts`;
  if (head === "Game") return `Game/${rest.join("/")}.d.ts`;
  return `Mod/${parts.join("/")}.d.ts`;
}

/** Property or method name as written in a class or interface body: plain when valid, else quoted. */
export function memberKey(name: string): string {
  return IDENT_RE.test(name) ? name : JSON.stringify(name);
}

/** Last segment of a module specifier, usable as an alias prefix. */
export function moduleBase(spec: string): string {
  return ident(spec.slice(spec.lastIndexOf("/") + 1));
}
