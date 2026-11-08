import { test } from "node:test";
import assert from "node:assert/strict";
import { PrefixIndex, matchName } from "../src/index.js";
import type { NameHit } from "../src/index.js";

/** Small deterministic generator (mulberry32) so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["Get", "Set", "Actor", "Pawn", "Timer", "Event", "HUD", "Class", "Widget", "Array", "Contains", "Item", "Player", "Max", "Health", "Spawn", "K2", "BP", "Print", "String", "Vector", "Is", "Valid", "Name", "Id"];

function randomName(r: () => number): string {
  const n = 1 + Math.floor(r() * 4);
  const parts: string[] = [];
  if (r() < 0.15) parts.push(r() < 0.5 ? "K2" : "BP");
  for (let i = 0; i < n; i++) parts.push(WORDS[Math.floor(r() * WORDS.length)] as string);
  const sep = r() < 0.2 ? "_" : "";
  const name = parts.join(sep);
  return r() < 0.1 ? `${name}${Math.floor(r() * 20)}` : name;
}

function randomDisplay(r: () => number): string | undefined {
  if (r() < 0.4) return undefined;
  const n = 1 + Math.floor(r() * 4);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(WORDS[Math.floor(r() * WORDS.length)] as string);
  return parts.join(r() < 0.5 ? " " : "-");
}

function randomPrefix(r: () => number, names: string[]): string {
  const base = names[Math.floor(r() * names.length)] as string;
  const from = r() < 0.5 ? 0 : Math.floor(r() * base.length);
  const len = 1 + Math.floor(r() * 5);
  let p = base.slice(from, from + len);
  if (p === "") p = base.slice(0, 1);
  return r() < 0.5 ? p.toLowerCase() : p;
}

test("PrefixIndex agrees with matchName on tier and filter text for every entry", () => {
  const r = rng(12345);
  const entries = Array.from({ length: 2000 }, (_, id) => {
    const displayName = randomDisplay(r);
    return { item: id, name: randomName(r), ...(displayName === undefined ? {} : { displayName }) };
  });
  const index = new PrefixIndex(entries);
  assert.equal(index.size, 2000);
  const names = entries.map((e) => e.name);
  const everything = (a: NameHit<number>, b: NameHit<number>): number => a.tier - b.tier || a.item - b.item;
  for (let i = 0; i < 200; i++) {
    const prefix = randomPrefix(r, names);
    const expected = new Map<number, { tier: number; filterText: string }>();
    for (const e of entries) {
      const m = matchName(e.name, e.displayName, prefix);
      if (m !== undefined) expected.set(e.item, { tier: m.tier, filterText: m.filterText });
    }
    const got = index.lookup(prefix, () => true, everything, Number.MAX_SAFE_INTEGER);
    assert.equal(got.length, expected.size, `hit count for "${prefix}"`);
    for (const h of got) {
      const want = expected.get(h.item);
      assert.ok(want, `unexpected hit ${entries[h.item]?.name} for "${prefix}"`);
      assert.equal(h.tier, want.tier, `tier of ${entries[h.item]?.name} for "${prefix}"`);
      assert.equal(h.filterText, want.filterText, `filterText of ${entries[h.item]?.name} for "${prefix}"`);
    }
  }
});

test("PrefixIndex: tiers come in order, accept filters, limit caps, empty prefix finds nothing", () => {
  const index = new PrefixIndex([
    { item: "a", name: "SetTimerByEvent", displayName: "Set Timer by Event" },
    { item: "b", name: "K2_Timer" },
    { item: "c", name: "Timer" },
    { item: "d", name: "ClearTimer" },
    { item: "e", name: "Other", displayName: "Timer Thing" },
  ]);
  const byTierThenItem = (a: NameHit<string>, b: NameHit<string>): number => a.tier - b.tier || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0);
  const all = index.lookup("timer", () => true, byTierThenItem, 100);
  assert.deepEqual(
    all.map((h) => `${h.tier}:${h.item}`),
    ["0:c", "1:b", "2:e", "3:a", "3:d"],
  );
  assert.deepEqual(
    index.lookup("timer", (i) => i !== "c", byTierThenItem, 100).map((h) => h.item),
    ["b", "e", "a", "d"],
  );
  assert.equal(index.lookup("timer", () => true, byTierThenItem, 2).length, 2);
  assert.deepEqual(index.lookup("", () => true, byTierThenItem, 100), []);
  // two typed characters: only name and stripped-name prefixes
  assert.deepEqual(
    index.lookup("ti", () => true, byTierThenItem, 100).map((h) => h.item),
    ["c", "b"],
  );
});

test("PrefixIndex: 30,000 entries answer 30 short lookups (limit 100) fast", () => {
  const r = rng(777);
  const entries = Array.from({ length: 30_000 }, (_, id) => {
    const displayName = randomDisplay(r);
    return { item: id, name: `${randomName(r)}${id}`, ...(displayName === undefined ? {} : { displayName }) };
  });
  const index = new PrefixIndex(entries);
  const names = entries.map((e) => e.name);
  const compare = (a: NameHit<number>, b: NameHit<number>): number => a.tier - b.tier || a.item - b.item;
  const t0 = performance.now();
  let total = 0;
  for (let i = 0; i < 30; i++) total += index.lookup(randomPrefix(r, names), () => true, compare, 100).length;
  const ms = performance.now() - t0;
  assert.ok(total > 0);
  // loose bound; the measured cost is a few milliseconds
  assert.ok(ms < 300, `30 lookups took ${ms.toFixed(1)} ms`);
});
