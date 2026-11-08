// The release artifact scanner (design 18.10): mod names, user and build paths, dev folders, game-derived files.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readZip } from "@abfc/env";
import { readTgz } from "./tar.mjs";

// Committed guard words: the mod-name fragments of the backend's name guard and the game-internal identifiers of abfc's
// own name guard. They are assembled from pieces so no file in a repository holds a whole word (the guards scan their
// repository). The game's own name is not a guard word: the product names it legitimately.
const GUARD_PIECES = [
  ["so", "up"],
  ["wag", "dd"],
  ["deployed", "_"],
  ["global", "item"],
];
export const GUARD_WORDS = GUARD_PIECES.map((p) => p.join(""));

const MB = 1024 * 1024;
const WINDOW = 8 * MB;
const OVERLAP = 4096;
const MAX_FINDINGS_PER_RULE = 1000;

const TEXT_EXT = /\.(js|cjs|mjs|ts|json|md|txt|py|iss|xml|vsixmanifest|html|css|pth|cfg|toml|yml|yaml)$/i;
const CONTAINER_EXT = /\.(zip|vsix|tgz)$/i;
const DEV_SEGMENTS = new Set([".claude", ".plans", ".abfc", ".git"]);
const GAME_FILES = [
  /\.uasset$/i,
  /\.umap$/i,
  /\.pak$/i,
  /\.utoc$/i,
  /\.ucas$/i,
  /^stubs\.lock\.json$/i,
  /^reflect.*\.json$/i,
  /^BlueprintFilter/i,
  /-files\.json\.gz$/i,
];

// Placeholders that may appear in documentation (a user named "Jane Doe" is the documented stand-in; a user whose
// first name word is "Jane" followed by a space is therefore not reported either).
const WIN_USER = /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!(?:Public|Default User|Default|All Users|Jane Doe|Jane|<you>)(?:[\\/\s"'<>|:*?]|$))(?<u>[^\\/\s"'<>|:*?]+)/gi;
// `/home/AppData/...` is the relative path of the headless runtime's redirected profile (documented in the bundled backend), not a user.
const HOME_USER =/(?<![\w.:])\/home\/(?!<you>\/|AppData\/)(?<u>[\w.-]+)/g;
const MAC_USER = /(?<![\w.:])\/Users\/(?!(?:Shared|Jane|<you>)\/)(?<u>[\w.-]+)/g;
const DEV_PATH = /(^|[\\/])\.(claude|plans)[\\/]/gi;

/**
 * Parses a name denylist: one name per line; blank lines and `#` comments are skipped, names are lowercased and
 * de-duplicated, an entry shorter than 3 characters throws (the message never holds the name).
 */
export function parseDenylist(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const word = line.toLowerCase();
    if (out.includes(word)) continue;
    if (word.length < 3) throw new Error(`denylist entry #${out.length + 1} is shorter than 3 characters`);
    out.push(word);
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
const mask = (user) => `${user.slice(0, 2)}***`;

function contextHash(text, index, len) {
  const part = text.slice(Math.max(0, index - 32), index + len + 32).toLowerCase();
  return createHash("sha256").update(part, "utf8").digest("hex");
}

const compiled = new WeakMap();

function compile(ctx) {
  const known = compiled.get(ctx);
  if (known !== undefined) return known;
  const names = (ctx.names ?? []).map((n) => {
    const word = String(n.word).toLowerCase();
    return { word, label: n.label, re: new RegExp(escapeRe(word), "gi") };
  });
  const roots = [];
  const root = String(ctx.repoRoot ?? "").replace(/[\\/]+$/, "");
  if (root.length >= 3) {
    const back = root.replace(/\//g, "\\");
    const forms = [
      [back, "backslash form"],
      [back.replace(/\\/g, "/"), "slash form"],
      [back.replace(/\\/g, "\\\\"), "escaped backslash form"],
    ];
    const seen = new Set();
    for (const [form, label] of forms) {
      const key = form.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ lower: key, label, re: new RegExp(escapeRe(form), "gi") });
    }
  }
  // one alternation over all names (longest first), used to replace a name in an entry chain with its label
  const byLongest = [...names].sort((a, b) => b.word.length - a.word.length);
  const entryRe = byLongest.length > 0 ? new RegExp(byLongest.map((n) => escapeRe(n.word)).join("|"), "gi") : null;
  const maskEntry = (chain) =>
    entryRe === null
      ? chain
      : chain.replace(entryRe, (hit) => `<${(names.find((n) => n.word === hit.toLowerCase()) ?? { label: "name" }).label}>`);
  const c = { names, roots, maskEntry };
  compiled.set(ctx, c);
  return c;
}

/** Findings of a decoded text: `{rule, detail, index, len, context}`. */
function textFindings(text, c, mode) {
  const out = [];
  const add = (rule, detail, index, len) => out.push({ rule, detail, index, len, context: contextHash(text, index, len) });
  const lower = text.toLowerCase();
  for (const n of c.names) {
    if (!lower.includes(n.word)) continue;
    n.re.lastIndex = 0;
    let count = 0;
    for (let m = n.re.exec(text); m !== null && count < MAX_FINDINGS_PER_RULE; m = n.re.exec(text), count++) {
      // In binary data a name of fewer than 5 characters also turns up by chance in compressed bytes (roughly one hit per
      // 100 MB), so there it must stand alone (no letter or digit on either side); longer names match anywhere.
      if (mode === "binary" && n.word.length < 5) {
        const before = m.index > 0 ? text[m.index - 1] : "";
        const after = text[m.index + m[0].length] ?? "";
        if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
      }
      add("name", n.label, m.index, m[0].length);
    }
  }
  for (const [re, prefix] of [
    [WIN_USER, "C:\\Users\\"],
    [HOME_USER, "/home/"],
    [MAC_USER, "/Users/"],
  ]) {
    re.lastIndex = 0;
    let count = 0;
    for (let m = re.exec(text); m !== null && count < MAX_FINDINGS_PER_RULE; m = re.exec(text), count++) {
      add("userPath", `${prefix}${mask(m.groups.u)}`, m.index, m[0].length);
    }
  }
  for (const r of c.roots) {
    if (!lower.includes(r.lower)) continue;
    r.re.lastIndex = 0;
    let count = 0;
    for (let m = r.re.exec(text); m !== null && count < MAX_FINDINGS_PER_RULE; m = r.re.exec(text), count++) {
      add("buildPath", `build folder of this repository (${r.label})`, m.index, m[0].length);
    }
  }
  if (mode !== "name") {
    DEV_PATH.lastIndex = 0;
    let count = 0;
    for (let m = DEV_PATH.exec(text); m !== null && count < MAX_FINDINGS_PER_RULE; m = DEV_PATH.exec(text), count++) {
      add("devPath", `.${m[2].toLowerCase()} folder`, m.index + m[1].length, m[0].length - m[1].length);
    }
  }
  return out;
}

/** Findings of a binary buffer: latin1 and UTF-16LE (both alignments) over 8 MB windows with an overlap. */
function binaryFindings(buf, c) {
  const out = [];
  // UTF-16 is decoded from an aligned, even-length scratch copy: decoding an odd-offset or odd-length Buffer view with
  // toString("utf16le") crashes Node (heap corruption).
  const scratch = Buffer.alloc(Math.min(buf.length, WINDOW + OVERLAP) + 2);
  for (let start = 0; start < buf.length; start += WINDOW) {
    const end = Math.min(buf.length, start + WINDOW + OVERLAP);
    const last = end >= buf.length;
    // a hit that starts in the overlap belongs to the next window (so it is reported once, with its full context)
    for (const f of textFindings(buf.toString("latin1", start, end), c, "binary")) {
      if (last || f.index < WINDOW) out.push(f);
    }
    for (const skip of [0, 1]) {
      const n = (end - start - skip) & ~1;
      if (n <= 0) continue;
      buf.copy(scratch, 0, start + skip, start + skip + n);
      for (const f of textFindings(scratch.toString("utf16le", 0, n), c, "binary")) {
        if (last || f.index * 2 < WINDOW) out.push(f);
      }
    }
  }
  return out;
}

function gameContentFindings(inner, text) {
  const out = [];
  const add = (detail, index, len) => out.push({ rule: "gameContent", detail, index, len, context: contextHash(text, index, len) });
  if (/\.d\.ts$/i.test(inner)) {
    const first = /\S[^\r\n]*/.exec(text);
    if (first !== null && /^\/\/ generated by abfc (?:stubs|generate)\b/.test(first[0])) add("generated stubs header", first.index, first[0].length);
    const tag = text.indexOf("@bpPath /Game/");
    if (tag >= 0) add("@bpPath /Game/ tag", tag, "@bpPath /Game/".length);
  } else if (/\.json$/i.test(inner)) {
    const re = /"\/Game\/[^"]*"\s*:/g;
    let count = 0;
    for (let m = re.exec(text); m !== null && count < MAX_FINDINGS_PER_RULE; m = re.exec(text), count++) {
      add("/Game/ key in JSON", m.index, m[0].length);
    }
  }
  return out;
}

function entryNameFindings(inner) {
  const out = [];
  const segments = inner.split(/[\\/]/);
  const base = segments[segments.length - 1];
  const add = (rule, detail) => out.push({ rule, detail, index: 0, len: inner.length, context: contextHash(inner, 0, inner.length) });
  for (const seg of segments) if (DEV_SEGMENTS.has(seg.toLowerCase())) add("devFile", `${seg.toLowerCase()} entry`);
  for (const re of GAME_FILES) if (re.test(base)) add("gameFile", "game-derived file name");
  return out;
}

/**
 * Scans one artifact file. `artifact` is the artifact kind (exe, zip, ...), `name` the file's name (the first element of
 * the entry chain), `ctx` = `{ names: [{word, label}], repoRoot, stats? }`. Returns `Hit[]`:
 * `{artifact, entry, rule, detail, context}` with `entry` the chain `outer.zip > inner.vsix > extension/x.js`.
 */
export function scanArtifact({ artifact, name, buf, ctx }) {
  const c = compile(ctx);
  const hits = [];
  const seen = new Set();
  const push = (chain, f) => {
    // names inside the entry chain (a file or folder named after a mod) are replaced by their label before the hit is
    // printed or matched against an exception
    const entry = c.maskEntry(chain);
    const key = `${entry}\0${f.rule}\0${f.detail}\0${f.context}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ artifact, entry, rule: f.rule, detail: f.detail, context: f.context });
  };

  const visit = (chain, inner, data, depth, recurse) => {
    if (ctx.stats !== undefined) ctx.stats.entries += 1;
    for (const f of textFindings(inner, c, "name")) push(chain, f);
    for (const f of entryNameFindings(inner)) push(chain, f);

    if (recurse && CONTAINER_EXT.test(inner)) {
      let children = null;
      try {
        children = /\.tgz$/i.test(inner)
          ? readTgz(data).map((e) => ({ name: e.name, read: () => e.data }))
          : readZip(data).map((e) => ({ name: e.name, read: () => e.read() }));
      } catch {
        children = null; // not a readable container: scanned as binary below
      }
      if (children !== null) {
        for (const e of children) {
          const keepPython = artifact === "runtime" && depth === 0 && e.name.startsWith("python/");
          visit(`${chain} > ${e.name}`, e.name, e.read(), depth + 1, !keepPython);
        }
        return;
      }
    }

    if (ctx.stats !== undefined) ctx.stats.bytes += data.length;
    if (TEXT_EXT.test(inner)) {
      const text = data.toString("utf8");
      for (const f of textFindings(text, c, "text")) push(chain, f);
      for (const f of gameContentFindings(inner, text)) push(chain, f);
    } else {
      for (const f of binaryFindings(data, c)) push(chain, f);
    }
  };

  visit(name, name, buf, 0, true);
  return hits;
}

/** Reads `release/scan-exceptions.json`: `{schemaVersion: 1, exceptions: [{rule, artifact, entry, context, reason}]}`. */
export function loadExceptions(file) {
  const json = JSON.parse(readFileSync(file, "utf8"));
  if (json.schemaVersion !== 1 || !Array.isArray(json.exceptions)) throw new Error(`${file}: expected {"schemaVersion":1,"exceptions":[...]}`);
  for (const [i, e] of json.exceptions.entries()) {
    for (const k of ["rule", "artifact", "entry", "context", "reason"]) {
      if (typeof e[k] !== "string" || e[k] === "") throw new Error(`${file}: exceptions[${i}].${k} must be a non-empty string`);
    }
    if (!/^[0-9a-f]{12,64}$/.test(e.context)) throw new Error(`${file}: exceptions[${i}].context must be 12 to 64 lowercase hex digits`);
  }
  return json.exceptions;
}

/** Splits hits into `failing` and `excepted`; `unused` = exceptions that matched no hit. A context may be a prefix (12+ hex). */
export function applyExceptions(hits, exceptions) {
  const used = new Set();
  const failing = [];
  const excepted = [];
  for (const h of hits) {
    const idx = exceptions.findIndex(
      (e) => e.rule === h.rule && e.artifact === h.artifact && e.entry === h.entry && h.context.startsWith(e.context),
    );
    if (idx >= 0) {
      used.add(idx);
      excepted.push(h);
    } else failing.push(h);
  }
  return { failing, excepted, unused: exceptions.filter((_, i) => !used.has(i)) };
}
