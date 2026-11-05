// Blueprint filter resolution and tag selection (design 5.1; port of the backend's bpscan.resolve).
import type { Profile } from "@abfc/ir";

export type FilterRules = Map<string, "Allow" | "Block">;
export interface FilterVerdict {
  verdict: "Allow" | "Block" | "Unlisted";
  /** The rule key that decided, or null. */
  rule: string | null;
}

/** `[["Allow", "<key>"], ["Block", "<key>"]]` (the backend's `filter.rules`) -> map. */
export function rulesFromPairs(pairs: ReadonlyArray<readonly ["Allow" | "Block", string]>): FilterRules {
  const m: FilterRules = new Map();
  for (const [verdict, key] of pairs) m.set(key, verdict);
  return m;
}

/** Member rule, then class rule, then module rule; `/Game` and `/Engine` paths are allowed; the rest is unlisted. */
export function resolveFilter(rules: FilterRules, parent: string, member?: string | null): FilterVerdict {
  if (member) {
    const key = `${parent} ${member}`;
    const v = rules.get(key);
    if (v !== undefined) return { verdict: v, rule: key };
  }
  const cv = rules.get(parent);
  if (cv !== undefined) return { verdict: cv, rule: parent };
  const mod = parent.split(".")[0] ?? parent;
  const mv = rules.get(mod);
  if (mv !== undefined) return { verdict: mv, rule: mod };
  if (parent.startsWith("/Game/") || parent.startsWith("/Engine/")) return { verdict: "Allow", rule: null };
  return { verdict: "Unlisted", rule: null };
}

export interface MemberFilterTags {
  /** Text after `@deprecated`, or null. */
  deprecated: string | null;
  /** Text after `@bpFilterOverride`, or null. */
  override: string | null;
}

/** A blocked member is `@deprecated` unless the profile lists an override for it. */
export function memberFilterTags(profile: Profile, rules: FilterRules, parent: string, member: string): MemberFilterTags {
  const r = resolveFilter(rules, parent, member);
  if (r.verdict !== "Block") return { deprecated: null, override: null };
  const o = profile.filterOverrides.find((x) => x.parent === parent && x.member === member);
  if (o) return { deprecated: null, override: `Block ${r.rule}: ${o.reason}` };
  return { deprecated: `Blocked by Blueprint filter: Block ${r.rule}`, override: null };
}

/** Text after `@bpCastFilter` for a class that resolves to Block, or null. */
export function classFilterTag(profile: Profile, rules: FilterRules, parent: string): string | null {
  const r = resolveFilter(rules, parent, null);
  if (r.verdict !== "Block") return null;
  const o = profile.filterOverrides.find((x) => x.cast === parent);
  return o ? `override Block ${r.rule}: ${o.reason}` : `Blocked by Blueprint filter: Block ${r.rule}`;
}
