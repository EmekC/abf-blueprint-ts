// Member names of mod-defined structs (UserDefinedStruct). Unreal names a member `<Field>_<index>_<32 hex GUID>`; abfc chooses the GUID
// itself (a hash of the struct and field name) so that Make/Break Struct pins can be named before the struct exists.
import { createHash } from "node:crypto";

/** The 32 upper-case hex digits of a field: `sha256("<structObjectPath>:<field>")` cut to 32 characters. */
export function udsGuid(structObjectPath: string, field: string): string {
  return createHash("sha256").update(`${structObjectPath}:${field}`, "utf8").digest("hex").slice(0, 32).toUpperCase();
}

/** `<field>_<index>_<GUID>`; `index` is the declaration index of the field in the struct. */
export function udsMemberName(structObjectPath: string, field: string, index: number): string {
  return `${field}_${index}_${udsGuid(structObjectPath, field)}`;
}
