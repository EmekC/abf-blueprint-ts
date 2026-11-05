import { readdirSync, readFileSync } from "node:fs";
import type { Profile } from "@abfc/ir";

const PROFILES_DIR = new URL("../../profiles/", import.meta.url);

function readJson(url: URL): Profile {
  const text = readFileSync(url, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text) as Profile;
}

/** All profile ids shipped in the package `profiles` folder, sorted. */
export function listProfileIds(): string[] {
  return readdirSync(PROFILES_DIR)
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
  return readJson(new URL(`${useId}.json`, PROFILES_DIR));
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
