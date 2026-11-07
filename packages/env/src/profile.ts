import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Profile } from "@abfc/ir";
import { runtimeLayout } from "./install.js";

let profilesDirCache: string | null = null;

/** The shipped `profiles` folder: the runtime folder in abfc.exe, else the package's own. */
function profilesDir(): string {
  profilesDirCache ??= runtimeLayout()?.profilesDir ?? fileURLToPath(new URL("../../profiles/", import.meta.url));
  return profilesDirCache;
}

function readJson(file: string): Profile {
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text) as Profile;
}

/** All profile ids shipped in the package `profiles` folder, sorted. */
export function listProfileIds(): string[] {
  return readdirSync(profilesDir())
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

/** Loads a profile by id; without an id the only shipped profile is returned. */
export function loadProfile(id?: string): Profile {
  let useId = id;
  if (useId === undefined) {
    const ids = listProfileIds();
    if (ids.length !== 1 || ids[0] === undefined) {
      throw new Error(`loadProfile: expected exactly one shipped profile, found ${ids.length}; pass an id`);
    }
    useId = ids[0];
  }
  return readJson(join(profilesDir(), `${useId}.json`));
}

/**
 * Finds the profile for an editor build. `appVersion` is the Epic manifest `AppVersionString`
 * (matches when it equals `epicAppVersion` or contains the profile `buildTag`).
 */
export function profileForBuild(appVersion: string | null): Profile | null {
  if (!appVersion) return null;
  for (const id of listProfileIds()) {
    const p = loadProfile(id);
    if (p.epicAppVersion !== null && p.epicAppVersion === appVersion) return p;
    if (p.buildTag && appVersion.includes(p.buildTag)) return p;
  }
  return null;
}
