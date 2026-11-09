// The docs search matcher. It uses the same four tiers the editor's completion list uses (matchName in
// packages/compiler/src/frontend/completions.ts, wordStarts/squash in nameindex.ts: copied here, kept equal by website/test/parity.test.mjs)
// and adds a subsequence tier, so a few key letters of a name ("prst") still find it; search() ranks documented nodes up and blocked nodes down.
// No imports: the browser loads this file as is.

const isUpper = (c) => c !== undefined && c >= "A" && c <= "Z";
const isLower = (c) => c !== undefined && c >= "a" && c <= "z";
const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";
const isLetter = (c) => isUpper(c) || isLower(c);
const isAlnum = (c) => isLetter(c) || isDigit(c);

/** Indexes (>= 1) in `s` where a word begins: after a separator, at a camel hump, at an acronym end (`HUDClass` -> `Class`) or at a digit run. */
export function wordStarts(s) {
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    const p = s[i - 1];
    const n = s[i + 1];
    if (
      (isAlnum(c) && !isAlnum(p)) ||
      (isUpper(c) && (isLower(p) || isDigit(p))) ||
      (isUpper(c) && isUpper(p) && isLower(n)) ||
      (isDigit(c) && isLetter(p))
    ) {
      out.push(i);
    }
  }
  return out;
}

export const squash = (s) => s.replace(/[^A-Za-z0-9_$]/g, "");

/** Typed characters needed before display-name and word-start matches count. */
export const MIN_WORD_MATCH = 3;

/** How `prefix` (case-insensitive) matches a function name or its Blueprint node name, best tier first; undefined when it does not. */
export function matchName(name, displayName, prefix) {
  const q = prefix.toLowerCase();
  if (q === "") return undefined;
  if (name.toLowerCase().startsWith(q)) return { tier: 0, filterText: name };
  const stripped = name.replace(/^(K2|BP)_/, "");
  if (stripped !== name && stripped.toLowerCase().startsWith(q)) return { tier: 1, filterText: stripped };
  if (q.length < MIN_WORD_MATCH) return undefined;
  const d = displayName === undefined ? "" : squash(displayName);
  if (d !== "" && d.toLowerCase().startsWith(q)) return { tier: 2, filterText: d };
  for (const i of wordStarts(name)) {
    const rest = name.slice(i);
    if (rest.toLowerCase().startsWith(q)) return { tier: 3, filterText: rest };
  }
  if (displayName !== undefined) {
    for (const i of wordStarts(displayName)) {
      const rest = squash(displayName.slice(i));
      if (rest.toLowerCase().startsWith(q)) return { tier: 3, filterText: rest };
    }
  }
  return undefined;
}

/** Positions of the characters of `q` in `lower`, taking a word start where one is ahead; undefined when `q` is not a subsequence. */
function matchPositions(lower, starts, q, preferStarts) {
  const positions = [];
  let from = 0;
  for (const c of q) {
    let at = -1;
    if (preferStarts) {
      for (const i of starts) {
        if (i >= from && lower[i] === c) {
          at = i;
          break;
        }
      }
    }
    if (at < 0) at = lower.indexOf(c, from);
    if (at < 0) return undefined;
    positions.push(at);
    from = at + 1;
  }
  return positions;
}

/** Score (1..500) of `q` (lowercase, no spaces) as a subsequence of `text`; 0 when its letters do not all occur in order. */
export function subseq(text, q) {
  if (q === "" || text === "") return 0;
  const lower = text.toLowerCase();
  const starts = [0, ...wordStarts(text)];
  const set = new Set(starts);
  let best = 0;
  for (const preferStarts of [true, false]) {
    const positions = matchPositions(lower, starts, q, preferStarts);
    if (positions === undefined) continue;
    const first = positions[0];
    const last = positions[positions.length - 1];
    const atStarts = positions.filter((p) => set.has(p)).length;
    const score = Math.max(1, 500 - 2 * (last - first + 1 - q.length) - first + 10 * atStarts);
    best = Math.max(best, score);
  }
  return best;
}

/** How well a search-index entry matches `query`: 0 = not at all, else higher is better (tiers 0-3 score 1000..700, the rest below 951). */
export function scoreEntry(entry, query) {
  const q = query.trim().toLowerCase().replace(/\s+/g, "");
  if (q === "") return 0;
  const name = entry.tsName || squash(entry.title);
  const t = matchName(name, entry.title, q);
  if (t !== undefined) return 1000 - 100 * t.tier;
  if (q.includes(".") && entry.qualified !== "" && entry.qualified.toLowerCase().startsWith(q)) return 950;
  if (q.length < 2) return 0;
  let best = 0;
  for (const text of [squash(entry.title), entry.tsName, entry.qualified]) {
    if (text) best = Math.max(best, subseq(text, q));
  }
  return best;
}

/**
 * Entries that match `query`, best first (rank, then shorter title, then title), at most `limit`. rank = score, plus 20 for an entry with a
 * hand-written description (`doc`), minus 50 for a node the Blueprint filter blocks (`blocked`), so usable and documented nodes win ties.
 */
export function search(entries, query, limit = 12) {
  const scored = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, query);
    if (score > 0) scored.push({ entry, score: score + (entry.doc ? 20 : 0) - (entry.blocked ? 50 : 0) });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.title.length - b.entry.title.length || (a.entry.title < b.entry.title ? -1 : a.entry.title > b.entry.title ? 1 : 0));
  return scored.slice(0, limit).map((s) => s.entry);
}
