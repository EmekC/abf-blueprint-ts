// Release pins (release/pins.json): load/save, sha256 helpers and the pinned download.
// An empty sha256 means "not yet pinned". Recording fills it once (never overwrites a non-empty pin).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadPins(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function savePins(file, pins) {
  writeFileSync(file, `${JSON.stringify(pins, null, 2)}\n`);
}

export function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

export function sha256File(path) {
  return sha256Buf(readFileSync(path));
}

/** The hex digest listed for `name` in a SHASUMS256.txt style text ("<hex>  <name>" per line), or null. */
export function parseShasums(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m !== null && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

function checkAgainstPin(actual, pin, what, recordHint) {
  if (pin === "") {
    if (recordHint.record) return true;
    throw new Error(`pin ${what} is empty: run node scripts/release/fetch-pins.mjs --record (needs approval)`);
  }
  if (actual !== pin) throw new Error(`${what}: sha256 mismatch (pinned ${pin}, actual ${actual})`);
  return false;
}

/**
 * Verifies (and when missing, downloads) one pinned file.
 * `pin` = { url, sha256 }. Returns { path, sha256, recorded }; `recorded` is true when the pin was empty and
 * `record` allowed accepting the actual hash (the caller writes it into the pins file).
 */
export async function fetchPinned(pin, dest, opts) {
  const what = opts.what;
  const hint = { record: opts.record === true };
  if (existsSync(dest)) {
    const actual = sha256File(dest);
    const recorded = checkAgainstPin(actual, pin.sha256, what, hint);
    return { path: dest, sha256: actual, recorded };
  }
  if (opts.download !== true) {
    throw new Error(`missing ${dest}: run node scripts/release/fetch-pins.mjs --download (needs approval)`);
  }
  if (pin.sha256 === "" && !hint.record) {
    throw new Error(`pin ${what} is empty: run node scripts/release/fetch-pins.mjs --record (needs approval)`);
  }
  const res = await fetch(pin.url);
  if (res.status !== 200) throw new Error(`${what}: ${pin.url} answered HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256Buf(buf);
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  writeFileSync(part, buf);
  let recorded;
  try {
    recorded = checkAgainstPin(actual, pin.sha256, what, hint);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  renameSync(part, dest);
  return { path: dest, sha256: actual, recorded };
}
