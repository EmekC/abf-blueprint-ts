// Reflection shapes consumed by the stub generator. Structurally identical to the `Reflect*` types of @abfc/backend
// (kept here so @abfc/stubgen depends only on ir and env).

/** One pin of a reflected member. */
export interface ReflectPin {
  name: string;
  dir: "in" | "out";
  category: string;
  subCategory: string;
  subCategoryObject: string | null;
  objectMeta: string | null;
  container: string;
  hidden: boolean;
  default: string | null;
}

export interface ReflectMember {
  name: string;
  pins: ReflectPin[];
  /** Function metadata read from the engine (backends with the reflect meta pass); null/absent when unreadable. */
  meta?: { tooltip?: string | null; displayName?: string | null; /** pin name -> default text from the UFunction `CPP_Default_*` metadata (backend 2.6.0); null when unreadable. */ defaults?: Record<string, string> | null } | null;
}

export interface ReflectClass {
  meta: string | null;
  /** Native ancestor class paths, nearest first. */
  ancestors: string[];
  functions: ReflectMember[];
  properties: ReflectMember[];
  castPin: string | null;
  /** The class appears only as a cast target: no member lists. */
  castOnly?: boolean;
}

/** `<run>/reflect.json` */
export interface ReflectData {
  engineVersion: string | null;
  classes: Record<string, ReflectClass>;
  structs: Record<string, { fields: ReflectPin[] }>;
  errors: string[];
}
