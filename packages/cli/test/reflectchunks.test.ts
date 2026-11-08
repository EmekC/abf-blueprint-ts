import { test } from "node:test";
import assert from "node:assert/strict";
import type { Backend, ReflectData, ReflectRequest, ReflectResult } from "@abfc/backend";
import { REFLECT_CHUNK, reflectAll } from "../src/reflectchunks.js";

const classPath = (i: number): string => `/Game/Fake/BP_${i}.BP_${i}_C`;

/** A backend whose reflect is scripted: throws when `fails` says so, otherwise answers one class record per requested class. */
function fakeBackend(fails: (r: ReflectRequest) => boolean, calls: ReflectRequest[], extra: (r: ReflectRequest) => Record<string, unknown> = () => ({})): Backend {
  return {
    reflect: async (r: ReflectRequest): Promise<ReflectResult> => {
      calls.push(r);
      if (fails(r)) throw new Error(`boom with ${r.classes.length} classes`);
      const data = {
        engineVersion: "5.4.4-fake",
        classes: Object.fromEntries(r.classes.map((c) => [c, { meta: null, ancestors: [], functions: [], properties: [], castPin: null }])),
        structs: Object.fromEntries(r.structs.map((s) => [s, { fields: [] }])),
        errors: r.classes.length > 0 ? [`note ${r.classes[0]}`] : [],
        ...extra(r),
      } as ReflectData;
      return { run: "R", seconds: 1, file: "", data, filter: { contentVersion: "v1", rules: [["Block", "X"]] } };
    },
  } as unknown as Backend;
}

const request = (classes: string[], more: Partial<ReflectRequest> = {}): ReflectRequest => ({
  mod: "TestMod",
  classes,
  structs: [],
  castTargets: classes.filter((c) => c.startsWith("/Game/")),
  ...more,
});

test("reflectAll: one call when it works", async () => {
  const calls: ReflectRequest[] = [];
  const lines: string[] = [];
  const out = await reflectAll(fakeBackend(() => false, calls), request([classPath(1), classPath(2)]), (l) => lines.push(l));
  assert.equal(calls.length, 1);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(Object.keys(out.result.data.classes), [classPath(1), classPath(2)]);
  assert.deepEqual(lines, []);
});

test("reflectAll: a failing call is split in chunks of 500 and the results are merged, including an unknown record key", async () => {
  const total = REFLECT_CHUNK * 2 + 100;
  const classes = Array.from({ length: total }, (_, i) => classPath(i));
  const calls: ReflectRequest[] = [];
  const lines: string[] = [];
  const backend = fakeBackend((r) => r.classes.length > REFLECT_CHUNK, calls, (r) => ({
    supers: Object.fromEntries(r.classes.map((c) => [c, ["/Script/FakeEngine.Thing"]])),
    gameplayTags: r.gameplayTags === true ? { tags: ["A.B"], sources: {} } : undefined,
  }));
  const out = await reflectAll(backend, request(classes, { gameplayTags: true }), (l) => lines.push(l));
  assert.deepEqual(out.failed, []);
  assert.equal(Object.keys(out.result.data.classes).length, total);
  const data = out.result.data as ReflectData & { supers: Record<string, string[]>; gameplayTags?: { tags: string[] } };
  assert.equal(Object.keys(data.supers).length, total, "a record key the CLI does not know is merged key by key");
  assert.deepEqual(data.gameplayTags?.tags, ["A.B"]);
  assert.equal(data.errors.length, 3, "arrays are concatenated");
  assert.equal(data.engineVersion, "5.4.4-fake");
  assert.deepEqual(out.result.filter, { contentVersion: "v1", rules: [["Block", "X"]] });
  assert.equal(out.result.seconds, 3);
  // the failed call, then three chunks; the gameplay tags go only with the first chunk
  assert.deepEqual(calls.map((c) => c.classes.length), [total, 500, 500, 100]);
  assert.deepEqual(calls.map((c) => c.gameplayTags), [true, true, undefined, undefined]);
  assert.deepEqual(calls[1]?.castTargets, calls[1]?.classes);
  assert.deepEqual(lines, ["stubs: reflect chunk 1/3 (500 classes)", "stubs: reflect chunk 2/3 (500 classes)", "stubs: reflect chunk 3/3 (100 classes)"]);
});

test("reflectAll: a list of at most 500 classes is bisected down to the single failing class", async () => {
  const classes = Array.from({ length: 9 }, (_, i) => classPath(i));
  const bad = classPath(5);
  const calls: ReflectRequest[] = [];
  const out = await reflectAll(fakeBackend((r) => r.classes.includes(bad), calls), request(classes), () => {});
  assert.deepEqual(out.failed, [bad]);
  assert.deepEqual(Object.keys(out.result.data.classes).sort(), classes.filter((c) => c !== bad).sort());
  assert.ok(calls.length < 2 * classes.length, "bisecting costs fewer calls than one per class twice over");
  assert.ok(calls.some((c) => c.classes.length === 1 && c.classes[0] === bad));
});

test("reflectAll: when every call fails the first error is thrown", async () => {
  const classes = Array.from({ length: 4 }, (_, i) => classPath(i));
  await assert.rejects(reflectAll(fakeBackend(() => true, []), request(classes), () => {}), /boom with 4 classes/);
});

test("reflectAll: when nothing works the retry gives up after a few single classes instead of one call per class", async () => {
  const classes = Array.from({ length: 3000 }, (_, i) => classPath(i));
  const calls: ReflectRequest[] = [];
  await assert.rejects(reflectAll(fakeBackend(() => true, calls), request(classes), () => {}), /boom with 3000 classes/);
  assert.ok(calls.length < 50, `${calls.length} calls`);
});

test("reflectAll: structs and tags go with the first successful call only; a bad class first in the list is still isolated", async () => {
  const classes = Array.from({ length: 9 }, (_, i) => classPath(i));
  const bad = classPath(0);
  const calls: ReflectRequest[] = [];
  const out = await reflectAll(fakeBackend((r) => r.classes.includes(bad), calls), request(classes, { structs: ["/Script/FakeEngine.FakeVec"] }), () => {});
  assert.deepEqual(out.failed, [bad]);
  const ok = calls.filter((c) => !c.classes.includes(bad));
  assert.deepEqual(ok[0]?.structs, ["/Script/FakeEngine.FakeVec"]);
  assert.ok(ok.slice(1).every((c) => c.structs.length === 0));
});

test("reflectAll: a single class or a request without classes is not retried", async () => {
  const calls: ReflectRequest[] = [];
  await assert.rejects(reflectAll(fakeBackend(() => true, calls), request([classPath(1)]), () => {}), /boom with 1 classes/);
  await assert.rejects(reflectAll(fakeBackend(() => true, calls), request([], { structs: ["/Script/FakeEngine.FakeVec"] }), () => {}), /boom with 0 classes/);
  assert.equal(calls.length, 2);
});
