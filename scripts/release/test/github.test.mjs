import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changelogSection, sumsText } from "../lib/github.mjs";

const LOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- nothing yet",
  "",
  "## [1.0.0] - unreleased",
  "",
  "### Added",
  "- one",
  "- two",
  "",
  "## [0.9.0] - 2026-01-01",
  "",
  "- older",
  "",
].join("\n");

describe("changelogSection", () => {
  it("returns the body up to the next section", () => {
    const body = changelogSection(LOG, "1.0.0");
    assert.equal(body, "### Added\n- one\n- two");
  });

  it("reads CRLF files", () => {
    assert.equal(changelogSection(LOG.replace(/\n/g, "\r\n"), "0.9.0"), "- older");
  });

  it("falls back to the release section for a prerelease", () => {
    assert.equal(changelogSection(LOG, "1.0.0-rc.1"), "### Added\n- one\n- two");
  });

  it("prefers an exact prerelease section", () => {
    const text = `${LOG}\n## [1.0.0-rc.1] - 2026-02-02\n\n- candidate\n`;
    assert.equal(changelogSection(text, "1.0.0-rc.1"), "- candidate");
  });

  it("throws when the section is missing", () => {
    assert.throws(() => changelogSection(LOG, "2.0.0"), /no section for "## \[2\.0\.0\]"/);
    assert.throws(() => changelogSection(LOG, "not-a-version"), /not a semver/);
  });
});

describe("sumsText", () => {
  it("writes sorted '<sha256>  <name>' lines", () => {
    const text = sumsText([
      { name: "b.zip", sha256: "bb" },
      { name: "a.exe", sha256: "aa" },
    ]);
    assert.equal(text, "aa  a.exe\nbb  b.zip\n");
  });

  it("is empty for no files", () => {
    assert.equal(sumsText([]), "");
  });
});
