// Class-defaults pass (design 6.2 pass 5): the FIXED Python template that sets class defaults on a Blueprint's CDO.
// Only values that passed the validation below reach the template; no text of the user's program is ever pasted into code.
import { AbfcError } from "@abfc/env";

interface DefaultKind {
  /** `bool` values are `True`/`False`, `float` values are `%f` text. */
  type: "bool" | "float";
  /** `unreal` editor property name (`set_editor_property`), or a CDO method name when `method` is set. */
  python: string;
  method?: boolean;
}

/** Class default (T3D property name) -> how the template writes it. */
export const DEFAULT_KINDS: Readonly<Record<string, DefaultKind>> = {
  bReplicates: { type: "bool", python: "replicates" },
  bAlwaysRelevant: { type: "bool", python: "always_relevant" },
  bOnlyRelevantToOwner: { type: "bool", python: "only_relevant_to_owner" },
  NetUpdateFrequency: { type: "float", python: "net_update_frequency" },
  MinNetUpdateFrequency: { type: "float", python: "min_net_update_frequency" },
  TickInterval: { type: "float", python: "set_actor_tick_interval", method: true },
  // bStartWithTickEnabled is deliberately absent: `set_actor_tick_enabled` on a CDO changes the tick function's state, not the saved
  // PrimaryActorTick.bStartWithTickEnabled, and the struct route (`primary_actor_tick.start_with_tick_enabled`) is not verified live.
};

const CLASS_PATH = /^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*\.[A-Za-z0-9_]+$/;
const ASSET_PATH = /^\/[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
const FLOAT_TEXT = /^\d+\.\d+$/;

function bad(message: string): AbfcError {
  return new AbfcError({ severity: "error", code: "ABFC2061", message }, 2);
}

/**
 * The Python code of the class-defaults pass for one Blueprint class. Throws ABFC2061 for a key or value outside the
 * validated map and for a path that is not a plain asset path.
 */
export function renderDefaultsCode(classPath: string, values: Readonly<Record<string, string>>, classManagerRow?: string): string {
  if (!CLASS_PATH.test(classPath)) throw bad(`class path "${classPath}" is not a plain class path`);
  if (classManagerRow !== undefined && !ASSET_PATH.test(classManagerRow)) throw bad(`classManagerRow "${classManagerRow}" is not a plain asset path`);
  const lines: string[] = [
    `cdo = unreal.get_default_object(unreal.load_class(None, ${JSON.stringify(classPath)}))`,
  ];
  for (const key of Object.keys(values).sort()) {
    const kind = DEFAULT_KINDS[key];
    const value = values[key]!;
    if (kind === undefined) throw bad(`class default "${key}" is not supported`);
    if (kind.type === "bool" && value !== "True" && value !== "False") throw bad(`class default ${key} must be True or False, got "${value}"`);
    if (kind.type === "float" && !FLOAT_TEXT.test(value)) throw bad(`class default ${key} must be a number written as %f text, got "${value}"`);
    lines.push(
      kind.method === true
        ? `cdo.${kind.python}(${value})`
        : `cdo.set_editor_property(${JSON.stringify(kind.python)}, ${value})`,
    );
  }
  if (classManagerRow !== undefined) {
    const pkg = classPath.slice(0, classPath.indexOf("."));
    lines.push(
      `row_asset = unreal.load_asset(${JSON.stringify(classManagerRow)})`,
      `row_text = str(row_asset.get_editor_property("row")) if row_asset is not None else ""`,
      `if ${JSON.stringify(pkg)} not in row_text:`,
      `    print(${JSON.stringify(`ABFC2070 class manager row ${classManagerRow} does not reference ${pkg}`)})`,
    );
  }
  return lines.join("\n") + "\n";
}
