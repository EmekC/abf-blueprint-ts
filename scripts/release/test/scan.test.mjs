import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { after, describe, it } from "node:test";
import { writeZip } from "@abfc/env";
import { GUARD_WORDS, applyExceptions, loadExceptions, parseDenylist, scanArtifact } from "../lib/scan.mjs";
import { readTgz } from "../lib/tar.mjs";

const tmp = mkdtempSync(join(tmpdir(), "abfc-rel-scan-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(repoRoot, "scripts", "release", "scan-artifacts.mjs");

// neutral placeholder words, assembled from pieces
const NAME = ["zebra", "foo"].join("");
const ROOT = "D:\\a\\build\\checkout";
const ctx = () => ({ names: [{ word: NAME, label: "denylist entry #1" }, ...GUARD_WORDS.map((word, i) => ({ word, label: `guard word #${i + 1}` }))], repoRoot: ROOT });
const utf = (s) => Buffer.from(s, "utf8");
const scan = (name, buf, artifact = "zip") => scanArtifact({ artifact, name, buf, ctx: ctx() });
const rules = (hits) => hits.map((h) => h.rule).sort();

function ustar(entries) {
  const blocks = [];
  for (const e of entries) {
    const head = Buffer.alloc(512);
    head.write(e.name, 0, "utf8");
    head.write("0000644\0", 100);
    head.write("0000000\0", 108);
    head.write("0000000\0", 116);
    head.write(`${e.data.length.toString(8).padStart(11, "0")}\0`, 124);
    head.write("00000000000\0", 136);
    head.fill(0x20, 148, 156);
    head.write("0", 156);
    head.write("ustar\0", 257);
    head.write("00", 263);
    let sum = 0;
    for (const b of head) sum += b;
    head.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(head, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("parseDenylist", () => {
  it("trims, skips blanks and comments, lowercases and de-duplicates", () => {
    assert.deepEqual(parseDenylist(`# names\r\n  Alpha \n\nBETA\nalpha\n`), ["alpha", "beta"]);
  });
  it("throws on a short entry without printing it", () => {
    assert.throws(() => parseDenylist("ok-name\nab\n"), (e) => /entry #2 is shorter/.test(e.message) && !/\bab\b/.test(e.message));
  });
});

describe("readTgz", () => {
  it("reads regular files and stops at the end blocks", () => {
    const files = readTgz(ustar([{ name: "package/a.js", data: utf("x") }, { name: "package/b.json", data: Buffer.alloc(600, 1) }]));
    assert.deepEqual(files.map((f) => [f.name, f.data.length]), [["package/a.js", 1], ["package/b.json", 600]]);
  });
});

describe("scanArtifact rules", () => {
  it("name: a denylist word in a .js entry is a hit whose detail has no word", () => {
    const hits = scan("pkg.zip", writeZip([{ name: "x.js", data: utf(`const a = "My-${NAME.toUpperCase()}-mod";`) }]));
    assert.deepEqual(rules(hits), ["name"]);
    assert.equal(hits[0].entry, "pkg.zip > x.js");
    assert.equal(hits[0].detail, "denylist entry #1");
    assert.ok(!JSON.stringify(hits).toLowerCase().includes(NAME));
    assert.match(hits[0].context, /^[0-9a-f]{64}$/);
  });

  it("name: a guard word is a hit", () => {
    const hits = scan("x.js", utf(`// ${GUARD_WORDS[0]}\n`));
    assert.deepEqual(hits.map((h) => [h.rule, h.detail]), [["name", "guard word #1"]]);
  });

  it("name: a short guard word inside binary bytes must stand alone, in text it matches anywhere", () => {
    const w = GUARD_WORDS[0];
    assert.equal(w.length, 4);
    assert.deepEqual(scan("abfc.exe", Buffer.concat([Buffer.alloc(4, 1), utf(`x-I${w}P-x`), Buffer.alloc(4, 1)]), "exe"), []);
    assert.deepEqual(scan("abfc.exe", Buffer.concat([Buffer.alloc(4, 1), utf(`x ${w} x`), Buffer.alloc(4, 1)]), "exe").map((h) => h.detail), ["guard word #1"]);
    assert.equal(scan("x.js", utf(`I${w}P`)).length, 1);
  });

  it("printable: counts printable characters around a match (window excluded), high in text and low in binary", () => {
    const text = scan("x.js", utf(`${"a".repeat(40)} ${NAME} ${"b".repeat(40)}`));
    assert.deepEqual(text[0].printable, { n: 64, of: 64 });
    const bin = Buffer.concat([Buffer.alloc(40, 1), Buffer.alloc(10, 0x80), utf(` ${NAME} `), Buffer.alloc(40, 2)]);
    const hits = scan("abfc.exe", bin, "exe");
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].printable, { n: 2, of: 64 });
    assert.ok(!JSON.stringify(hits).toLowerCase().includes(NAME));
  });

  it("userPath: reports a user, masked; placeholders and Public are not hits", () => {
    const hits = scan("x.js", utf("a C:\\Users\\alice\\x b"));
    assert.deepEqual(hits.map((h) => [h.rule, h.detail]), [["userPath", "C:\\Users\\al***"]]);
    for (const ok of ["C:\\Users\\Public\\x", "C:/Users/Jane/x", "C:\\Users\\<you>\\x", "C:\\Users\\Jane Doe\\x", '"C:\\\\Users\\\\Public"']) {
      assert.deepEqual(scan("x.js", utf(ok)), [], ok);
    }
    assert.deepEqual(rules(scan("x.js", utf("C:/Users/Janet/x"))), ["userPath"]);
  });

  it("userPath: unix home folders", () => {
    assert.deepEqual(scan("x.js", utf("at /home/bob/x")).map((h) => h.detail), ["/home/bo***"]);
    assert.deepEqual(scan("x.js", utf("at /Users/carol/x")).map((h) => h.detail), ["/Users/ca***"]);
    assert.deepEqual(scan("x.js", utf("at /Users/Shared/x /home/<you>/x <root>/home/AppData/Local/x")), []);
  });

  it("buildPath: the repo root in either slash style", () => {
    assert.deepEqual(rules(scan("x.js", utf(`at ${ROOT}\\dist\\a.js`))), ["buildPath"]);
    assert.deepEqual(rules(scan("x.js", utf(`at ${ROOT.replace(/\\/g, "/")}/dist/a.js`))), ["buildPath"]);
    assert.deepEqual(rules(scan("x.js", utf(`"${ROOT.replace(/\\/g, "\\\\")}\\\\a"`))), ["buildPath"]);
  });

  it("gameFile and devFile by entry name", () => {
    const hits = scan("pkg.zip", writeZip([
      { name: "x.uasset", data: utf("a") },
      { name: "ok/readme.md", data: utf("b") },
      { name: ".abfc/a.json", data: utf("{}") },
      { name: "data/BlueprintFilter.txt", data: utf("c") },
    ]));
    assert.deepEqual(hits.map((h) => [h.rule, h.entry]).sort(), [
      ["devFile", "pkg.zip > .abfc/a.json"],
      ["gameFile", "pkg.zip > data/BlueprintFilter.txt"],
      ["gameFile", "pkg.zip > x.uasset"],
    ]);
  });

  it("devPath: .claude and .plans folders in text", () => {
    assert.deepEqual(scan("x.js", utf("see C:/x/.claude/worktrees/x")).map((h) => [h.rule, h.detail]), [["devPath", ".claude folder"]]);
    assert.deepEqual(scan("x.js", utf("see ./notes/.plans\\a")).map((h) => h.rule), ["devPath"]);
  });

  it("gameContent: stubs header, @bpPath tag and /Game/ JSON keys", () => {
    assert.deepEqual(scan("a.d.ts", utf("\n// generated by abfc stubs 1\nexport {};\n")).map((h) => h.rule), ["gameContent"]);
    assert.deepEqual(scan("a.d.ts", utf("/** @bpPath /Game/A/B */\n")).map((h) => h.rule), ["gameContent"]);
    assert.deepEqual(scan("a.d.ts", utf("export declare const a: number;\n")), []);
    assert.deepEqual(scan("r.json", utf('{ "/Game/A/B": { "x": 1 } }')).map((h) => h.rule), ["gameContent"]);
    assert.deepEqual(scan("r.json", utf('{ "path": "/Game/A/B" }')), []);
  });

  it("binary: a UTF-16LE user path at an odd offset and a latin1 one are found", () => {
    const utf16 = Buffer.concat([Buffer.alloc(3, 1), Buffer.from("C:\\Users\\carol\\x", "utf16le"), Buffer.alloc(9, 2)]);
    const h1 = scan("abfc.exe", utf16, "exe");
    assert.deepEqual(h1.map((h) => [h.rule, h.detail]), [["userPath", "C:\\Users\\ca***"]]);
    const latin = Buffer.concat([Buffer.alloc(5, 1), utf("C:\\Users\\dave\\y"), Buffer.alloc(5, 2)]);
    assert.deepEqual(scan("abfc.exe", latin, "exe").map((h) => h.detail), ["C:\\Users\\da***"]);
    assert.deepEqual(scan("abfc.exe", Buffer.alloc(100, 7), "exe"), []);
  });

  it("recursion: .vsix in .zip, and .tgz", () => {
    const vsix = writeZip([{ name: "extension/x.js", data: utf(`// ${NAME}`) }]);
    const outer = writeZip([{ name: "inner.vsix", data: vsix }, { name: "clean.txt", data: utf("fine") }]);
    const hits = scan("outer.zip", outer);
    assert.deepEqual(hits.map((h) => [h.rule, h.entry]), [["name", "outer.zip > inner.vsix > extension/x.js"]]);
    const tgz = ustar([{ name: "package/lib.js", data: utf(`x ${NAME} y`) }, { name: "package/package.json", data: utf("{}") }]);
    assert.deepEqual(scan("pkg-1.0.0.tgz", tgz, "npm").map((h) => h.entry), ["pkg-1.0.0.tgz > package/lib.js"]);
  });

  it("a name in a file or folder name of the entry chain is replaced by its label in the entry", () => {
    const inner = writeZip([{ name: `${NAME}-dir/${GUARD_WORDS[0]}.txt`, data: utf("fine") }]);
    const outer = writeZip([{ name: `${NAME.toUpperCase()}.vsix`, data: inner }]);
    const hits = scan("outer.zip", outer);
    assert.ok(hits.length > 0);
    for (const h of hits) {
      assert.ok(!h.entry.toLowerCase().includes(NAME), h.entry);
      assert.ok(!h.entry.toLowerCase().includes(GUARD_WORDS[0]), h.entry);
    }
    assert.ok(hits.some((h) => h.entry === "outer.zip > <denylist entry #1>.vsix > <denylist entry #1>-dir/<guard word #1>.txt"));
    // an exception is matched against the masked entry
    const target = hits.find((h) => h.rule === "name");
    const exc = { rule: target.rule, artifact: "zip", entry: target.entry, context: target.context, reason: "test" };
    assert.equal(applyExceptions([target], [exc]).excepted.length, 1);
  });

  it("runtime.zip: python/ entries are scanned but not recursed", () => {
    const inner = writeZip([{ name: "mod.py", data: utf(`# ${NAME}
`.repeat(200)) }]);
    const runtime = writeZip([{ name: "python/lib.zip", data: inner }, { name: "backend/other.zip", data: inner }]);
    const hits = scanArtifact({ artifact: "runtime", name: "runtime.zip", buf: runtime, ctx: ctx() });
    assert.deepEqual([...new Set(hits.map((h) => h.entry))], ["runtime.zip > backend/other.zip > mod.py"]);
  });

  it("a hit in a large binary is reported once with a stable context", () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 100, 0x41);
    utf("C:\\Users\\erin\\z").copy(big, 8 * 1024 * 1024 - 5);
    const hits = scan("abfc.exe", big, "exe");
    assert.deepEqual(hits.map((h) => h.detail), ["C:\\Users\\er***"]);
  });
});

describe("exceptions", () => {
  it("a matching context excepts a hit; an unmatched exception is unused", () => {
    const hits = scan("x.js", utf("a C:\\Users\\alice\\x b"));
    const h = hits[0];
    const good = { rule: h.rule, artifact: h.artifact, entry: h.entry, context: h.context.slice(0, 12), reason: "test" };
    const other = { rule: "name", artifact: "zip", entry: "x.js", context: "0".repeat(12), reason: "test" };
    const r = applyExceptions(hits, [good, other]);
    assert.equal(r.failing.length, 0);
    assert.equal(r.excepted.length, 1);
    assert.deepEqual(r.unused, [other]);
    assert.equal(applyExceptions(hits, [{ ...good, context: "f".repeat(12) }]).failing.length, 1);
  });

  it("loadExceptions validates the file", () => {
    const ok = join(tmp, "exc-ok.json");
    writeFileSync(ok, '{"schemaVersion":1,"exceptions":[]}');
    assert.deepEqual(loadExceptions(ok), []);
    const bad = join(tmp, "exc-bad.json");
    writeFileSync(bad, '{"schemaVersion":1,"exceptions":[{"rule":"name"}]}');
    assert.throws(() => loadExceptions(bad), /artifact/);
    assert.deepEqual(loadExceptions(join(repoRoot, "release", "scan-exceptions.json")), []);
  });
});

describe("scan-artifacts.mjs", () => {
  const run = (root, args, env = {}) =>
    spawnSync(process.execPath, [script, "--version", "1.0.0", "--repo-root", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

  it("a missing required artifact exits 2; an optional one is reported", () => {
    const root = mkdtempSync(join(tmp, "root-"));
    const r = run(root, ["--require", "vsix"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /required artifact not found: vsix/);
  });

  it("a planted name fails with exit 1 and prints no word; a clean artifact passes with 0", () => {
    const root = mkdtempSync(join(tmp, "root-"));
    mkdirSync(join(root, "build", "vsix"), { recursive: true });
    const vsix = join(root, "build", "vsix", "abfc-vscode-1.0.0.vsix");
    writeFileSync(vsix, writeZip([{ name: "extension/x.js", data: utf(`// ${NAME}`) }]));
    const deny = join(tmp, "deny.txt");
    writeFileSync(deny, `${NAME}\n`);
    const bad = run(root, ["--require", "vsix", "--denylist", deny]);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /HIT name vsix > abfc-vscode-<version>\.vsix > extension\/x\.js: denylist entry #1 \[context [0-9a-f]{12}, 3\/3 printable\]/);
    assert.ok(!(bad.stdout + bad.stderr).toLowerCase().includes(NAME));
    writeFileSync(vsix, writeZip([{ name: "extension/x.js", data: utf("// fine") }]));
    const good = run(root, ["--require", "vsix", "--denylist", deny]);
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /summary: 1 artifact kind\(s\)/);
  });
});
