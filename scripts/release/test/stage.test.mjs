import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { sha256Buf } from "../lib/pins.mjs";
import { listingOf, stageRelease } from "../lib/stage.mjs";

const tmp = mkdtempSync(join(tmpdir(), "abfc-rel-stage-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("stageRelease", () => {
  it("stages the files with CRLF text files, clears the output folder and lists the result", () => {
    const src = join(tmp, "src");
    const out = join(tmp, "out");
    mkdirSync(src, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "stale.txt"), "old");
    const p = (n) => join(src, n);
    writeFileSync(p("abfc.exe"), "MZ-exe");
    writeFileSync(p("abfc-vscode-9.9.9.vsix"), "PK-vsix");
    writeFileSync(p("notices.txt"), "notices\n");
    writeFileSync(p("LICENSE"), "line1\nline2\n");
    writeFileSync(p("README.template"), "abfc {version}\nsecond {version}\n");

    const names = stageRelease({
      exe: p("abfc.exe"),
      vsix: p("abfc-vscode-9.9.9.vsix"),
      notices: p("notices.txt"),
      licenseFile: p("LICENSE"),
      readmeTemplate: p("README.template"),
      version: "9.9.9",
      outDir: out,
    });
    assert.deepEqual(names, ["LICENSE.txt", "README.txt", "THIRD-PARTY-NOTICES.txt", "abfc-vscode-9.9.9.vsix", "abfc.exe"]);
    assert.equal(readFileSync(join(out, "LICENSE.txt"), "utf8"), "line1\r\nline2\r\n");
    assert.equal(readFileSync(join(out, "README.txt"), "utf8"), "abfc 9.9.9\r\nsecond 9.9.9\r\n");
    assert.equal(readFileSync(join(out, "abfc.exe"), "utf8"), "MZ-exe");

    const listing = listingOf(out);
    assert.deepEqual(listing.map((x) => x.name), names);
    const exe = listing.find((x) => x.name === "abfc.exe");
    assert.deepEqual(exe, { name: "abfc.exe", size: 6, sha256: sha256Buf(Buffer.from("MZ-exe")) });
  });
});
