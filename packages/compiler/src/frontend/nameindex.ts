// Prefix lookup over many names (tens of thousands of classes and functions) without scanning them: per match tier a sorted array of
// lowercase keys, a binary search for the typed prefix and a walk over the matching range only. Tiers are the ones `matchName`
// (completions.ts) defines; the property test in nameindex.test.ts keeps both in step.

const isUpper = (c: string | undefined): boolean => c !== undefined && c >= "A" && c <= "Z";
const isLower = (c: string | undefined): boolean => c !== undefined && c >= "a" && c <= "z";
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isLetter = (c: string | undefined): boolean => isUpper(c) || isLower(c);
const isAlnum = (c: string | undefined): boolean => isLetter(c) || isDigit(c);

/** Indexes (>= 1) in `s` where a word begins: after a separator, at a camel hump, at an acronym end (`HUDClass` -> `Class`) or at a digit run. */
export function wordStarts(s: string): number[] {
  const out: number[] = [];
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

export const squash = (s: string): string => s.replace(/[^A-Za-z0-9_$]/g, "");

/** Typed characters needed before display-name and word-start matches count. */
export const MIN_WORD_MATCH = 3;

export interface NameHit<T> {
  item: T;
  /** 0 full-name prefix, 1 prefix of the name without `K2_`/`BP_`, 2 prefix of the display name, 3 word start inside the name or display name. */
  tier: 0 | 1 | 2 | 3;
  /** The matched text from the match point on (what a client should filter on). */
  filterText: string;
}

interface Key {
  /** Lowercase text the prefix is matched against. */
  key: string;
  entry: number;
  /** Word-start order inside tier 3 (smaller wins for one entry); 0 elsewhere. */
  order: number;
  filterText: string;
}

const byKey = (a: Key, b: Key): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.order - b.order);

/** First index in `keys` whose key is >= `q`. */
function lowerBound(keys: Key[], q: string): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((keys[mid] as Key).key < q) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class PrefixIndex<T> {
  private readonly items: T[] = [];
  private readonly tiers: [Key[], Key[], Key[], Key[]] = [[], [], [], []];

  constructor(entries: ReadonlyArray<{ item: T; name: string; displayName?: string }>) {
    const [t0, t1, t2, t3] = this.tiers;
    entries.forEach((e, entry) => {
      this.items.push(e.item);
      const { name, displayName } = e;
      t0.push({ key: name.toLowerCase(), entry, order: 0, filterText: name });
      const stripped = name.replace(/^(K2|BP)_/, "");
      if (stripped !== name) t1.push({ key: stripped.toLowerCase(), entry, order: 0, filterText: stripped });
      if (displayName !== undefined) {
        const d = squash(displayName);
        if (d !== "") t2.push({ key: d.toLowerCase(), entry, order: 0, filterText: d });
      }
      for (const i of wordStarts(name)) {
        const rest = name.slice(i);
        t3.push({ key: rest.toLowerCase(), entry, order: i, filterText: rest });
      }
      if (displayName !== undefined) {
        for (const i of wordStarts(displayName)) {
          const rest = squash(displayName.slice(i));
          if (rest !== "") t3.push({ key: rest.toLowerCase(), entry, order: 1000 + i, filterText: rest });
        }
      }
    });
    for (const t of this.tiers) t.sort(byKey);
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * The entries `prefix` (case-insensitive) matches, best tier first and by `compare` inside a tier, at most `limit`; only entries
   * `accept` allows. Display-name and word-start tiers need `MIN_WORD_MATCH` typed characters.
   */
  lookup(prefix: string, accept: (item: T) => boolean, compare: (a: NameHit<T>, b: NameHit<T>) => number, limit: number): NameHit<T>[] {
    const q = prefix.toLowerCase();
    if (q === "" || limit <= 0) return [];
    const out: NameHit<T>[] = [];
    const seen = new Set<number>();
    const lastTier = q.length >= MIN_WORD_MATCH ? 3 : 1;
    for (let tier = 0; tier <= lastTier && out.length < limit; tier++) {
      const keys = this.tiers[tier] as Key[];
      const best = new Map<number, Key>();
      for (let i = lowerBound(keys, q); i < keys.length; i++) {
        const k = keys[i] as Key;
        if (!k.key.startsWith(q)) break;
        if (seen.has(k.entry)) continue;
        const prev = best.get(k.entry);
        if (prev === undefined || k.order < prev.order) best.set(k.entry, k);
      }
      const hits: NameHit<T>[] = [];
      for (const [entry, k] of best) {
        seen.add(entry);
        const item = this.items[entry] as T;
        if (accept(item)) hits.push({ item, tier: tier as 0 | 1 | 2 | 3, filterText: k.filterText });
      }
      hits.sort(compare);
      for (const h of hits) {
        if (out.length >= limit) break;
        out.push(h);
      }
    }
    return out;
  }
}
