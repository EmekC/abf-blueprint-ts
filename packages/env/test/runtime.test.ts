import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbfcError,
  RUNTIME_MARKER,
  cleanRuntimes,
  ensureRuntime,
  isExe,
  layoutAt,
  runtimeFolderName,
  runtimeLayout,
  runtimeRoot,
  verifyRuntime,
  writeZip,
  type RuntimeManifest,
  type RuntimeSource,
} from "../src/index.js";

const roots: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "abfc-rt-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const FILES: Record<string, string> = {
  "backend/server.py": "SERVER_VERSION = \"9.9.9\"\n",
  "backend/editor/kit.py": "print('kit')\n".repeat(50),
  "python/python.exe": "MZ-not-really",
  "profiles/p.json": "{}\n",
};

function build(files: Record<string, string>, abfcVersion = "1.0.0"): { manifest: RuntimeManifest; zip: Buffer } {
  const names = Object.keys(files).sort();
  const zip = writeZip(names.map((name) => ({ name, data: Buffer.from(files[name]!, "utf8") })));
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    abfcVersion,
    zipSha256: sha(zip),
    files: Object.fromEntries(names.map((n) => [n, { size: Buffer.byteLength(files[n]!), sha256: sha(Buffer.from(files[n]!, "utf8")) }])),
  };
  return { manifest, zip };
}

function sourceOf(b: { manifest: RuntimeManifest; zip: Buffer }, onZip?: () => void): RuntimeSource {
  return {
    manifest: () => b.manifest,
    zip: () => {
      onZip?.();
      return b.zip;
    },
  };
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof AbfcError, String(e));
    return e.diagnostic.code;
  }
  return "none";
}

test("ensureRuntime: fresh extraction writes every file and the marker", () => {
  const root = temp();
  const b = build(FILES);
  const r = ensureRuntime(sourceOf(b), root);
  assert.equal(r.extracted, true);
  assert.equal(r.repaired, false);
  assert.equal(r.dir, join(root, runtimeFolderName(b.manifest)));
  for (const [name, content] of Object.entries(FILES)) assert.equal(readFileSync(join(r.dir, ...name.split("/")), "utf8"), content);
  const marker = JSON.parse(readFileSync(join(r.dir, RUNTIME_MARKER), "utf8")) as { zipSha256: string; files: number };
  assert.equal(marker.zipSha256, b.manifest.zipSha256);
  assert.equal(marker.files, Object.keys(FILES).length);
  assert.deepEqual(readdirSync(root), [runtimeFolderName(b.manifest)]);
  assert.deepEqual(verifyRuntime(r.dir, b.manifest, true), []);
});

test("ensureRuntime: a second call extracts nothing", () => {
  const root = temp();
  const b = build(FILES);
  const first = ensureRuntime(sourceOf(b), root);
  const stamp = statSync(join(first.dir, RUNTIME_MARKER)).mtimeMs;
  let zipCalls = 0;
  const second = ensureRuntime(sourceOf(b, () => zipCalls++), root);
  assert.deepEqual(second, { dir: first.dir, extracted: false, repaired: false });
  assert.equal(zipCalls, 0);
  assert.equal(statSync(join(second.dir, RUNTIME_MARKER)).mtimeMs, stamp);
});

test("ensureRuntime: a file with a different size is repaired", () => {
  const root = temp();
  const b = build(FILES);
  const first = ensureRuntime(sourceOf(b), root);
  const target = join(first.dir, "backend", "server.py");
  writeFileSync(target, FILES["backend/server.py"] + " ");
  const r = ensureRuntime(sourceOf(b), root);
  assert.equal(r.extracted, true);
  assert.equal(r.repaired, true);
  assert.equal(readFileSync(target, "utf8"), FILES["backend/server.py"]);
  assert.deepEqual(readdirSync(root), [runtimeFolderName(b.manifest)]);
});

test("ensureRuntime: a missing file is repaired", () => {
  const root = temp();
  const b = build(FILES);
  const first = ensureRuntime(sourceOf(b), root);
  rmSync(join(first.dir, "profiles", "p.json"));
  const r = ensureRuntime(sourceOf(b), root);
  assert.equal(r.repaired, true);
  assert.equal(readFileSync(join(first.dir, "profiles", "p.json"), "utf8"), "{}\n");
});

test("ensureRuntime: same-size damage passes the quick check and is repaired with deep", () => {
  const root = temp();
  const b = build(FILES);
  const first = ensureRuntime(sourceOf(b), root);
  const target = join(first.dir, "profiles", "p.json");
  writeFileSync(target, "[]\n"); // same size as "{}\n"
  assert.deepEqual(verifyRuntime(first.dir, b.manifest, false), []);
  assert.deepEqual(ensureRuntime(sourceOf(b), root), { dir: first.dir, extracted: false, repaired: false });
  assert.equal(readFileSync(target, "utf8"), "[]\n");
  assert.equal(verifyRuntime(first.dir, b.manifest, true).length, 1);
  const deep = ensureRuntime(sourceOf(b), root, { deep: true });
  assert.equal(deep.extracted, true);
  assert.equal(deep.repaired, true);
  assert.equal(readFileSync(target, "utf8"), "{}\n");
});

test("ensureRuntime: a marker of another build forces a re-extraction", () => {
  const root = temp();
  const b = build(FILES);
  const first = ensureRuntime(sourceOf(b), root);
  writeFileSync(join(first.dir, RUNTIME_MARKER), JSON.stringify({ abfcVersion: "1.0.0", zipSha256: "0".repeat(64), files: 1 }));
  assert.equal(ensureRuntime(sourceOf(b), root).repaired, true);
  assert.deepEqual(verifyRuntime(first.dir, b.manifest, true), []);
});

test("ensureRuntime: a zip that does not match its manifest is ABFC1052", () => {
  const root = temp();
  const b = build(FILES);
  const wrong = { manifest: { ...b.manifest, zipSha256: "a".repeat(64) }, zip: b.zip };
  assert.equal(code(() => ensureRuntime(sourceOf(wrong), root)), "ABFC1052");
  assert.deepEqual(readdirSync(root), []);
});

test("ensureRuntime: an entry that the manifest does not list is ABFC1052 and leaves no temp folder", () => {
  const root = temp();
  const b = build(FILES);
  const files = { ...b.manifest.files };
  delete files["profiles/p.json"];
  const manifest: RuntimeManifest = { ...b.manifest, files };
  assert.equal(code(() => ensureRuntime(sourceOf({ manifest, zip: b.zip }), root)), "ABFC1052");
  assert.deepEqual(readdirSync(root), []);
});

test("ensureRuntime: a manifest file that the zip lacks is ABFC1052", () => {
  const root = temp();
  const small = build({ "a.txt": "a" });
  const manifest: RuntimeManifest = { ...small.manifest, files: { ...small.manifest.files, "b.txt": { size: 1, sha256: sha(Buffer.from("b")) } } };
  assert.equal(code(() => ensureRuntime(sourceOf({ manifest, zip: small.zip }), root)), "ABFC1052");
  assert.deepEqual(readdirSync(root), []);
});

test("ensureRuntime: an entry whose content differs from the manifest is ABFC1052", () => {
  const root = temp();
  const b = build({ "a.txt": "aaaa" });
  const manifest: RuntimeManifest = { ...b.manifest, files: { "a.txt": { size: 4, sha256: sha(Buffer.from("bbbb")) } } };
  assert.equal(code(() => ensureRuntime(sourceOf({ manifest, zip: b.zip }), root)), "ABFC1052");
  assert.deepEqual(readdirSync(root), []);
});

test("ensureRuntime: losing the rename race uses the winner and leaves no temp folder", () => {
  const root = temp();
  const b = build(FILES);
  let nested: ReturnType<typeof ensureRuntime> | undefined;
  const outer = sourceOf(b, () => {
    // the other process finishes first, while this one is about to extract
    nested ??= ensureRuntime(sourceOf(build(FILES)), root);
  });
  const r = ensureRuntime(outer, root);
  assert.equal(nested?.extracted, true);
  assert.equal(r.extracted, false);
  assert.equal(r.dir, nested?.dir);
  assert.deepEqual(readdirSync(root), [runtimeFolderName(b.manifest)]);
  assert.deepEqual(verifyRuntime(r.dir, b.manifest, true), []);
});

test("ensureRuntime: an unwritable runtime root is ABFC1050", () => {
  const root = temp();
  const blocker = join(root, "file");
  writeFileSync(blocker, "x");
  assert.equal(code(() => ensureRuntime(sourceOf(build(FILES)), join(blocker, "sub"))), "ABFC1050");
});

test("cleanRuntimes keeps the named folder and removes everything else", () => {
  const root = temp();
  for (const d of ["1.0.0-keep0000", "0.9.0-aaaaaaaa", ".tmp-x-1-abcd", ".bad-y-2-ef01"]) {
    mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, d, "f.txt"), "x");
  }
  writeFileSync(join(root, "stray.txt"), "x");
  const r = cleanRuntimes(root, "1.0.0-keep0000");
  assert.deepEqual(r.failed, []);
  assert.equal(r.removed.length, 4);
  assert.deepEqual(readdirSync(root), ["1.0.0-keep0000"]);
  assert.deepEqual(cleanRuntimes(join(root, "missing"), null), { removed: [], failed: [] });
  assert.equal(cleanRuntimes(root, null).removed.length, 1);
  assert.equal(existsSync(join(root, "1.0.0-keep0000")), false);
});

test("runtimeRoot: ABFC_RUNTIME_DIR wins, then LOCALAPPDATA", () => {
  assert.equal(runtimeRoot({ ABFC_RUNTIME_DIR: "D:\\rt", LOCALAPPDATA: "D:\\local" }), "D:\\rt");
  assert.equal(runtimeRoot({ abfc_runtime_dir: "D:\\rt2" }), "D:\\rt2");
  assert.equal(runtimeRoot({ ABFC_RUNTIME_DIR: "", LOCALAPPDATA: "D:\\local" }), "D:\\local\\abfc\\runtime");
  assert.equal(runtimeRoot({ LocalAppData: "D:\\local" }), "D:\\local\\abfc\\runtime");
  assert.match(runtimeRoot({}), /AppData\\Local\\abfc\\runtime$/);
});

test("layoutAt builds the runtime paths", () => {
  const l = layoutAt("D:\\rt\\1.0.0-abcdef12", "1.0.0");
  assert.equal(l.backendDir, "D:\\rt\\1.0.0-abcdef12\\backend");
  assert.equal(l.pythonExe, "D:\\rt\\1.0.0-abcdef12\\python\\python.exe");
  assert.equal(l.profilesDir, "D:\\rt\\1.0.0-abcdef12\\profiles");
  assert.equal(l.descriptionsJson, "D:\\rt\\1.0.0-abcdef12\\data\\descriptions.json");
  assert.equal(l.runtimeDts, "D:\\rt\\1.0.0-abcdef12\\types\\runtime\\index.d.ts");
  assert.equal(l.testkitDts, "D:\\rt\\1.0.0-abcdef12\\types\\testkit\\index.d.ts");
  assert.equal(l.irDts, "D:\\rt\\1.0.0-abcdef12\\types\\ir\\index.d.ts");
  assert.equal(l.tsLibDir, "D:\\rt\\1.0.0-abcdef12\\tslib");
  assert.equal(l.schemaJson, "D:\\rt\\1.0.0-abcdef12\\schema\\abf.config.schema.json");
  assert.equal(l.abfcVersion, "1.0.0");
});

test("under node --test this is not an exe", () => {
  assert.equal(isExe(), false);
  assert.equal(runtimeLayout(), null);
});
