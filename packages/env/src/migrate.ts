import { toModRelative } from "@abfc/ir";
import { CONFIG_SCHEMA_VERSION, PROJECT_CONFIG_FILE } from "./config.js";
import { envError } from "./errors.js";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface MigratedConfig {
  /** The schema-2 text (2-space JSON plus newline), or the input unchanged when it already is schema 2 or newer. */
  text: string;
  /** Machine-specific keys taken out of the project config, by dotted name (`editor.root`, `modsDir`, ...). */
  machineKeys: Record<string, string>;
  /** Schema-1 `stubs.modAssets` entries that named another mod and could not be made mod-relative (dropped). */
  droppedModAssets: string[];
}

/** Dotted machine keys: top-level name, or `group.key`. */
const MACHINE_KEYS: Array<[group: string | null, key: string]> = [
  ["editor", "root"],
  [null, "modsDir"],
  [null, "headlessDir"],
  ["mod", "dir"],
  ["backend", "serverDir"],
  ["backend", "python"],
];

/**
 * Upgrades the text of a schema-1 `abf.config.json` to schema 2 (docs/design.md 18.4): `schemaVersion` becomes the
 * first key, `stubs.modAssets` entries `/<mod>/X` become `X`, and the machine keys move out (returned with dotted
 * names so `abfc init` can offer them to the user config). Other keys and their order stay. Schema 2 input is
 * returned unchanged. ABFC1021 when the text is not a JSON object.
 */
export function migrateProjectConfigText(text: string): MigratedConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw envError(
      1021,
      `${PROJECT_CONFIG_FILE} is invalid at $: not valid JSON (${(e as Error).message}).`,
      [{ source: PROJECT_CONFIG_FILE, detail: `$: not valid JSON (${(e as Error).message})` }],
      `fix "$" in ${PROJECT_CONFIG_FILE} (UTF-8 JSON).`,
    );
  }
  if (!isObj(parsed)) {
    throw envError(
      1021,
      `${PROJECT_CONFIG_FILE} is invalid at $: expected an object.`,
      [{ source: PROJECT_CONFIG_FILE, detail: "$: expected an object" }],
      `fix "$" in ${PROJECT_CONFIG_FILE} (UTF-8 JSON).`,
    );
  }
  const sv = parsed.schemaVersion;
  if (typeof sv === "number" && sv >= CONFIG_SCHEMA_VERSION) return { text, machineKeys: {}, droppedModAssets: [] };

  const { schemaVersion: _old, ...rest } = parsed;
  void _old;
  const root: Obj = { schemaVersion: CONFIG_SCHEMA_VERSION, ...rest };
  const machineKeys: Record<string, string> = {};
  const droppedModAssets: string[] = [];

  for (const [group, key] of MACHINE_KEYS) {
    const holder = group === null ? root : root[group];
    if (!isObj(holder)) continue;
    const value = holder[key];
    if (typeof value !== "string") continue;
    machineKeys[group === null ? key : `${group}.${key}`] = value;
    delete holder[key];
    if (group !== null && group !== "mod" && Object.keys(holder).length === 0) delete root[group];
  }

  const mod = isObj(root.mod) && typeof root.mod.name === "string" ? root.mod.name : null;
  const stubs = root.stubs;
  if (isObj(stubs) && Array.isArray(stubs.modAssets)) {
    const out: string[] = [];
    for (const entry of stubs.modAssets) {
      if (typeof entry !== "string") continue;
      if (!entry.startsWith("/")) {
        out.push(entry);
        continue;
      }
      const rel = mod === null ? null : toModRelative(mod, entry);
      if (rel === null) droppedModAssets.push(entry);
      else out.push(rel);
    }
    stubs.modAssets = out;
  }

  return { text: `${JSON.stringify(root, null, 2)}\n`, machineKeys, droppedModAssets };
}
