import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { CACHE_FILE, COVERAGE_FILE, LIBRARY_FILE, NAMES_FILE, coverageOf, newLock, readCoverage, readLock, readStubCache, writeFileAtomic, writeStubSet } from "../src/index.js";
import type { ReflectData, StubSet } from "../src/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "abfc-store-"));
}

function data(): ReflectData {
  return {
    engineVersion: "5.4.4-fake",
    classes: {
      "/Script/FakeEngine.Thing": { meta: "/Script/CoreUObject.Class", ancestors: [], functions: [], properties: [], castPin: null },
      "/Game/Fake/BP_Fake.BP_Fake_C": { meta: null, ancestors: [], functions: [], properties: [], castPin: null, castOnly: true },
    },
    structs: { "/Script/FakeEngine.FThing": { fields: [] } },
    errors: [],
  };
}

function setOf(files: Record<string, string>, over: Partial<StubSet> = {}): StubSet {
  const d = data();
  return {
    files: new Map(Object.entries(files)),
    index: { files: Object.keys(files).length },
    lock: newLock({
      profile: "p1",
      engineVersion: null,
      modEditorVersion: "1",
      editorFingerprint: "fp-1",
      filterContentVersion: null,
      classes: [],
      scriptClasses: [],
      modAssets: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    coverage: coverageOf(d, ["/Script/FakeEngine.EFake"], []),
    cache: { version: 1, generator: "0.5.0", editorFingerprint: "fp-1", reflect: d, filter: { contentVersion: "v1", rules: [["Block", "X"]] }, manual: [] },
    library: { version: 1, entries: [] },
    names: { version: 1, types: [], functions: [] },
    clearRetired: false,
    ...over,
  };
}

function allFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...allFiles(dir, r));
    else out.push(r);
  }
  return out.sort();
}

test("writeFileAtomic writes, replaces and leaves no temporary file", () => {
  const dir = tmp();
  try {
    const f = join(dir, "a", "b.txt");
    writeFileAtomic(f, "one");
    writeFileAtomic(f, "two");
    assert.equal(readFileSync(f, "utf8"), "two");
    writeFileAtomic(join(dir, "bin"), new Uint8Array([1, 2, 3]));
    assert.deepEqual([...readFileSync(join(dir, "bin"))], [1, 2, 3]);
    assert.deepEqual(allFiles(dir), ["a/b.txt", "bin"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic over a directory fails, rethrows and removes the temporary file", () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, "target"));
    assert.throws(() => writeFileAtomic(join(dir, "target"), "x"));
    assert.deepEqual(readdirSync(dir), ["target"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStubSet: an unchanged file keeps its mtime, a stale file and its empty folder go, lock is written", () => {
  const dir = tmp();
  try {
    const first = writeStubSet(dir, setOf({ "Game/X.d.ts": "x", "Game/Old/Y.d.ts": "y", "Script/S.d.ts": "s" }));
    assert.deepEqual(first, { written: 3, unchanged: 0, removed: 0 });
    const past = new Date(2020, 0, 1);
    utimesSync(join(dir, "Script", "S.d.ts"), past, past);
    const second = writeStubSet(dir, setOf({ "Game/X.d.ts": "x2", "Script/S.d.ts": "s" }));
    assert.deepEqual(second, { written: 1, unchanged: 1, removed: 1 });
    assert.equal(statSync(join(dir, "Script", "S.d.ts")).mtimeMs, past.getTime());
    assert.equal(readFileSync(join(dir, "Game", "X.d.ts"), "utf8"), "x2");
    assert.equal(existsSync(join(dir, "Game", "Old")), false);
    assert.equal(readLock(dir)?.editorFingerprint, "fp-1");
    assert.ok(allFiles(dir).every((f) => !f.endsWith(".tmp")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStubSet keeps retired.json, gameplay-tags.json and _catalog.json; clearRetired removes retired.json only", () => {
  const dir = tmp();
  try {
    for (const f of ["retired.json", "gameplay-tags.json", "_catalog.json"]) writeFileSync(join(dir, f), "[]", "utf8");
    writeStubSet(dir, setOf({ "Game/X.d.ts": "x" }));
    assert.ok(["retired.json", "gameplay-tags.json", "_catalog.json"].every((f) => existsSync(join(dir, f))));
    writeStubSet(dir, setOf({ "Game/X.d.ts": "x" }, { clearRetired: true }));
    assert.equal(existsSync(join(dir, "retired.json")), false);
    assert.ok(existsSync(join(dir, "gameplay-tags.json")) && existsSync(join(dir, "_catalog.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStubSet removes an old lock first and writes the new one last; names null removes _names.json", () => {
  const dir = tmp();
  try {
    writeStubSet(dir, setOf({ "Game/X.d.ts": "x" }));
    assert.ok(existsSync(join(dir, NAMES_FILE)));
    const next = setOf({ "Game/X.d.ts": "x" }, { names: null });
    next.lock = { ...next.lock, editorFingerprint: "fp-2" };
    writeStubSet(dir, next);
    assert.equal(readLock(dir)?.editorFingerprint, "fp-2");
    assert.equal(existsSync(join(dir, NAMES_FILE)), false);
    assert.deepEqual(allFiles(dir), ["Game/X.d.ts", COVERAGE_FILE, CACHE_FILE, "_index.json", LIBRARY_FILE, "stubs.lock.json"].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache round trip and corrupt or foreign cache reads as null", () => {
  const dir = tmp();
  try {
    assert.equal(readStubCache(dir), null);
    writeStubSet(dir, setOf({ "Game/X.d.ts": "x" }));
    const cache = readStubCache(dir);
    assert.equal(cache?.editorFingerprint, "fp-1");
    assert.deepEqual(cache?.filter.rules, [["Block", "X"]]);
    assert.deepEqual(Object.keys(cache!.reflect.classes).sort(), ["/Game/Fake/BP_Fake.BP_Fake_C", "/Script/FakeEngine.Thing"]);
    assert.ok(gunzipSync(readFileSync(join(dir, CACHE_FILE))).length > 0);
    writeFileSync(join(dir, CACHE_FILE), "not gzip", "utf8");
    assert.equal(readStubCache(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverageOf: reflected excludes cast-only classes, declared adds them and the opaque types", () => {
  const c = coverageOf(data(), ["/Script/FakeEngine.EFake"], ["warn"]);
  assert.deepEqual(c.reflected, ["/Script/FakeEngine.FThing", "/Script/FakeEngine.Thing"]);
  assert.deepEqual(c.declared, ["/Game/Fake/BP_Fake.BP_Fake_C", "/Script/FakeEngine.EFake", "/Script/FakeEngine.FThing", "/Script/FakeEngine.Thing"]);
  assert.deepEqual(c.errors, ["warn"]);
  const dir = tmp();
  try {
    assert.equal(readCoverage(dir), null);
    writeStubSet(dir, setOf({ "Game/X.d.ts": "x" }));
    assert.deepEqual(readCoverage(dir)?.reflected, c.reflected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
