/**
 * Asset path primitives shared by the environment (config parsing) and the compiler (derived paths).
 * Unreal allows only A-Z, a-z, 0-9 and `_` in the package path segments abfc generates; see docs/design.md 18.1.
 */

/** Longest allowed package path, `/<mod>/.../<Class>`. */
export const MAX_PACKAGE_PATH = 160;
/** Longest allowed folder segment or class name. */
export const MAX_SEGMENT = 64;
/** Default `sourceRoot` of a project. */
export const DEFAULT_SOURCE_ROOT = "src";
/** Default mod-relative folder of the class-manager rows. */
export const DEFAULT_CLASS_MANAGER_TABLE = "DataTables/DT_ClassManager";

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Null when `seg` is a valid folder or asset name; otherwise the reason, phrased to follow the segment. */
export function segmentProblem(seg: string): string | null {
  if (seg === "") return "is empty";
  if (seg.length > MAX_SEGMENT) return `is longer than ${MAX_SEGMENT} characters`;
  const bad = /[^A-Za-z0-9_]/u.exec(seg);
  if (bad) return `contains "${bad[0]}" (Unreal allows only A-Z, a-z, 0-9 and _ in asset paths)`;
  if (RESERVED_WINDOWS.test(seg)) return "is a reserved Windows name";
  return null;
}

/** {@link segmentProblem} plus the `_C` suffix reserved for generated classes. */
export function classNameProblem(name: string): string | null {
  const p = segmentProblem(name);
  if (p !== null) return p;
  if (name.endsWith("_C")) return "ends in _C (reserved for generated classes)";
  return null;
}

/** Null when `rel` is a valid mod-relative package path such as `Relays/BP_X`; otherwise the reason. */
export function modRelativeProblem(rel: string): string | null {
  if (rel.startsWith("/")) return "must not start with /";
  if (rel.endsWith("/")) return "must not end with /";
  if (rel.includes("\\")) return "must use / as the separator, not \\";
  if (rel.includes("//")) return "must not contain //";
  for (const seg of rel.split("/")) {
    const p = segmentProblem(seg);
    if (p !== null) return `"${seg}" ${p}`;
  }
  return null;
}

/** Null when the whole package path is short enough. */
export function packagePathProblem(path: string): string | null {
  if (path.length > MAX_PACKAGE_PATH) return `is longer than ${MAX_PACKAGE_PATH} characters`;
  return null;
}

/** `/<mod>/<rel>`. */
export function joinModPath(mod: string, rel: string): string {
  return `/${mod}/${rel}`;
}

/** The part of `path` below `/<mod>/` (prefix compared case-insensitively, remainder in its original case), else null. */
export function toModRelative(mod: string, path: string): string | null {
  const prefix = `/${mod}/`;
  if (path.length < prefix.length) return null;
  if (path.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  return path.slice(prefix.length);
}
