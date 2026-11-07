import { CONFIG_SCHEMA_VERSION } from "./config.js";
import { envError } from "./errors.js";

/** The machine-specific values `abfc init` may write into the user config (docs/design.md 18.4). */
export interface UserConfigPatch {
  editorRoot?: string;
  modsDir?: string;
  backendDir?: string;
  python?: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merges `patch` into the text of a user config file (null = no file yet). Sets `schemaVersion: 2`, `editor.root`,
 * `modsDir`, `backend.serverDir` and `backend.python` for the patched keys; keeps every other key and the key order;
 * new keys go last (`schemaVersion` first when it is new). `changedKeys` lists the dotted names that were added or
 * changed. When nothing changes, an existing text is returned as it was.
 * ABFC1021 when the existing text is not a JSON object; `file` names it in the message.
 */
export function updateUserConfigText(
  existing: string | null,
  patch: UserConfigPatch,
  file = "the user config",
): { text: string; changedKeys: string[] } {
  let root: Obj = {};
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing.replace(/^﻿/, ""));
    } catch (e) {
      throw envError(
        1021,
        `${file} is invalid at $: not valid JSON (${(e as Error).message}).`,
        [{ source: file, detail: `$: not valid JSON (${(e as Error).message})` }],
        `fix ${file} (UTF-8 JSON) or delete it.`,
      );
    }
    if (!isObj(parsed)) {
      throw envError(
        1021,
        `${file} is invalid at $: expected an object.`,
        [{ source: file, detail: "$: expected an object" }],
        `fix ${file} (UTF-8 JSON) or delete it.`,
      );
    }
    root = parsed;
  }

  const changedKeys: string[] = [];

  // schemaVersion: first key when new; an existing 2 or newer value stays.
  const sv = root.schemaVersion;
  if (typeof sv !== "number" || sv < CONFIG_SCHEMA_VERSION) {
    if (sv === undefined) root = { schemaVersion: CONFIG_SCHEMA_VERSION, ...root };
    else root.schemaVersion = CONFIG_SCHEMA_VERSION;
    changedKeys.push("schemaVersion");
  }

  const setTop = (key: string, value: string | undefined): void => {
    if (value === undefined || root[key] === value) return;
    root[key] = value;
    changedKeys.push(key);
  };
  const setNested = (group: string, key: string, value: string | undefined): void => {
    if (value === undefined) return;
    const current = root[group];
    const inner: Obj = isObj(current) ? current : {};
    if (inner[key] === value) return;
    inner[key] = value;
    root[group] = inner;
    changedKeys.push(`${group}.${key}`);
  };

  setNested("editor", "root", patch.editorRoot);
  setTop("modsDir", patch.modsDir);
  setNested("backend", "serverDir", patch.backendDir);
  setNested("backend", "python", patch.python);

  if (existing !== null && changedKeys.length === 0) return { text: existing, changedKeys };
  return { text: `${JSON.stringify(root, null, 2)}\n`, changedKeys };
}
