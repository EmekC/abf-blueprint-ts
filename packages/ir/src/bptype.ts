// bp_apply type grammar helpers (port of the MCP backend's t3d.parse_type and bpscan._var_type).

export class BpTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BpTypeError";
  }
}

export type BpContainer = "None" | "Array" | "Set" | "Map";
export interface ParsedBpType { cat: string; sub: string; path: string | null; container: BpContainer }

const SIMPLE: Record<string, [string, string]> = {
  exec: ["exec", ""], int: ["int", ""], int64: ["int64", ""], bool: ["bool", ""], byte: ["byte", ""],
  name: ["name", ""], string: ["string", ""], text: ["text", ""],
  real: ["real", "double"], double: ["real", "double"], float: ["real", "float"],
};
const OBJ_KINDS: Record<string, string> = {
  object: "object", class: "class", softobject: "softobject", softclass: "softclass",
  interface: "interface", struct: "struct", enum: "byte",
};

export function parseBpType(t: string): ParsedBpType {
  if (typeof t !== "string" || t.trim() === "") throw new BpTypeError(`type must be a non-empty string, got ${JSON.stringify(t)}`);
  t = t.trim();
  if (t.startsWith("array:")) {
    const inner = parseBpType(t.slice(6));
    if (inner.container !== "None") throw new BpTypeError(`nested containers are not supported: ${t}`);
    return { ...inner, container: "Array" };
  }
  const colon = t.indexOf(":");
  const head = colon < 0 ? t : t.slice(0, colon);
  if (head === "set" || head === "map") throw new BpTypeError(`${head} types are not supported (arrays only): ${t}`);
  const simple = Object.hasOwn(SIMPLE, t) ? SIMPLE[t] : undefined;
  if (simple) return { cat: simple[0], sub: simple[1], path: null, container: "None" };
  const objCat = Object.hasOwn(OBJ_KINDS, head) ? OBJ_KINDS[head] : undefined;
  if (objCat !== undefined && colon >= 0) {
    const path = t.slice(colon + 1).trim();
    if (path === "") throw new BpTypeError(`type "${head}" needs a path (a struct with no type crashes the import)`);
    return { cat: objCat, sub: "", path, container: "None" };
  }
  if (objCat !== undefined) throw new BpTypeError(`type "${head}" needs a path, e.g. ${head}:/Script/Engine.Actor`);
  throw new BpTypeError(
    `unknown type ${JSON.stringify(t)} (exec int int64 bool byte name string text real double float ` +
    "object:<path> class:<path> softobject:<path> softclass:<path> interface:<path> struct:<path> enum:<path> array:<type>)",
  );
}

/** Object text of a pin's `PinSubCategoryObject`, e.g. `/Script/CoreUObject.Class'/Script/Engine.Actor'`. */
export function pinObjectText(kind: string, path: string, classMeta: Record<string, string>): string {
  const ref = (meta: string): string => `${meta}'${path}'`;
  const script = path.startsWith("/Script/");
  if (kind === "struct") return ref(script ? "/Script/CoreUObject.ScriptStruct" : "/Script/Engine.UserDefinedStruct");
  if (kind === "enum") return ref(script ? "/Script/CoreUObject.Enum" : "/Script/Engine.UserDefinedEnum");
  if (script) return ref("/Script/CoreUObject.Class");
  return ref(classMeta[path] ?? "/Script/Engine.BlueprintGeneratedClass");
}

const PATH_CATEGORIES = new Set(["object", "class", "softobject", "softclass", "interface", "struct"]);

/** Grammar string for an exported pin or variable type (inverse of `parseBpType` for the supported types). */
export function bpTypeFromPin(p: {
  category: string;
  subCategory: string;
  subCategoryObject: string | null;
  container: string;
}): string {
  const path = p.subCategoryObject;
  let inner: string;
  switch (p.category) {
    case "bool": case "int": case "int64": case "name": case "string": case "text":
      inner = p.category;
      break;
    case "real":
      inner = p.subCategory === "float" ? "float" : "real";
      break;
    case "byte":
      inner = path ? `enum:${path}` : "byte";
      break;
    default:
      if (!PATH_CATEGORIES.has(p.category)) throw new BpTypeError(`pin category "${p.category}" has no bp_apply type`);
      if (!path) throw new BpTypeError(`pin category "${p.category}" has no object path`);
      inner = `${p.category}:${path}`;
  }
  if (p.container === "None" || p.container === "") return inner;
  if (p.container === "Array") return `array:${inner}`;
  throw new BpTypeError(`${p.container.toLowerCase()} containers are not supported (arrays only)`);
}
