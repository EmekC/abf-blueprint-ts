// Text checks of the GitHub Actions workflows (design 18.10). There is no YAML library in the repository and actionlint is not
// run locally, so these tests check the safety properties on the text: nothing publishes on a push or pull request, permissions
// stay minimal, only the npm-publish job (dispatch only) has the `npm` environment, the token and provenance, and secrets never reach a script line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function load(name) {
  return readFileSync(join(root, ".github", "workflows", name), "utf8").replace(/\r\n/g, "\n");
}

/** Lines that are not blank and not full-line comments. */
function codeLines(text) {
  return text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

/** Job name -> the text of its block (header line included), for the two-space-indented keys under `jobs:`. */
function jobBlocks(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  assert.ok(start >= 0, "no jobs: section");
  const out = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !line.startsWith(" ")) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m !== null) {
      current = m[1];
      out.set(current, []);
    }
    if (current !== null) out.get(current).push(line);
  }
  return new Map([...out].map(([k, v]) => [k, v.join("\n")]));
}

/** The indented lines of a top-level key such as `permissions:`. */
function topBlock(text, key) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `${key}:`);
  assert.ok(start >= 0, `no top-level ${key}:`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== "" && !line.startsWith(" ")) break;
    if (line.trim() !== "") body.push(line.trim());
  }
  return body;
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

const FILES = ["ci.yml", "release.yml"];

describe("both workflows", () => {
  for (const name of FILES) {
    const text = load(name);
    const code = codeLines(text);

    it(`${name}: basic YAML hygiene (no tabs, even indentation, balanced expressions, known top-level keys)`, () => {
      assert.ok(!text.includes("\t"), "tab character");
      for (const line of code) {
        const indent = /^ */.exec(line)[0].length;
        assert.equal(indent % 2, 0, `odd indentation: ${line}`);
        if (indent === 0) assert.match(line, /^(name|on|permissions|concurrency|jobs):/, `unexpected top-level line: ${line}`);
        assert.equal(count(line, "${{"), count(line, "}}"), `unbalanced expression: ${line}`);
      }
      for (const [job, block] of jobBlocks(text)) {
        assert.match(block, /^ {4}runs-on: (windows-latest|ubuntu-latest)$/m, `${job}: runs-on`);
        assert.match(block, /^ {4}timeout-minutes: \d+$/m, `${job}: timeout-minutes`);
        assert.match(block, /^ {4}steps:$/m, `${job}: steps`);
      }
    });

    it(`${name}: every action is pinned to @v4 or a full commit SHA`, () => {
      const uses = code.filter((l) => /^\s*-?\s*uses:/.test(l));
      assert.ok(uses.length > 0);
      for (const line of uses) assert.match(line, /uses: [\w.-]+\/[\w.-]+@(v4|[0-9a-f]{40})\s*$/, line);
    });

    it(`${name}: top-level permissions are exactly contents: read`, () => {
      assert.deepEqual(topBlock(text, "permissions"), ["contents: read"]);
    });

    it(`${name}: every checkout drops the persisted credentials`, () => {
      assert.equal(count(text, "uses: actions/checkout@"), count(text, "persist-credentials: false"));
    });

    it(`${name}: not triggered by pull_request_target, no inherited secrets`, () => {
      assert.ok(!text.includes("pull_request_target"));
      assert.ok(!/secrets:\s*inherit/.test(text));
    });

    it(`${name}: a secret appears only as an env mapping value, never in a script or an echo`, () => {
      for (const line of code) {
        if (!line.includes("secrets.")) continue;
        assert.match(line, /^\s+[A-Z][A-Z_]*: \$\{\{ secrets\.[A-Z_]+ \}\}$/, `secret outside an env mapping: ${line}`);
        assert.ok(!line.includes("echo"), line);
      }
      for (const line of code) assert.ok(!(line.includes("echo") && line.includes("secrets.")), line);
    });

    it(`${name}: untrusted inputs reach scripts only through env or a validated step output`, () => {
      for (const line of code) {
        if (!/inputs\.|ref_name|head_ref|github\.event\./.test(line)) continue;
        assert.match(line.trim(), /^(- )?(ref|group|if|[A-Z][A-Z_]*):/, `input used outside ref/group/if/env: ${line}`);
      }
    });
  }
});

describe("ci.yml", () => {
  const text = load("ci.yml");
  const code = codeLines(text).join("\n");

  it("runs on pull requests, pushes to main and manual dispatch only", () => {
    const on = topBlock(text, "on");
    assert.deepEqual(on, ["pull_request:", "push:", "branches: [main]", "workflow_dispatch:"]);
    assert.ok(!/^\s+tags:/m.test(code));
  });

  it("cannot publish or release anything", () => {
    for (const needle of ["npm publish", "gh release", "id-token", "NPM_TOKEN", "contents: write", "--provenance", "environment:"]) {
      assert.ok(!code.includes(needle), `ci.yml contains ${needle}`);
    }
    assert.ok(code.includes("contents: read"));
  });

  it("cancels superseded runs of the same ref", () => {
    assert.deepEqual(topBlock(text, "concurrency"), ["group: ci-${{ github.ref }}", "cancel-in-progress: true"]);
  });

  it("tests on Node 24 and 26.7.0 and packs the npm tarballs as a dry run", () => {
    const jobs = jobBlocks(text);
    const test = jobs.get("test");
    assert.ok(test.includes('node: ["24", "26.7.0"]'));
    assert.ok(test.includes("node scripts/release/pack-npm.mjs --dry-run"));
    assert.ok(test.includes("npm run build") && test.includes("run: npm test"));
  });

  it("scans without any name secret or denylist requirement", () => {
    const artifacts = jobBlocks(text).get("artifacts");
    assert.ok(!code.includes("ABFC_NAME_DENYLIST"));
    assert.ok(!code.includes("--require-denylist"));
    assert.ok(artifacts.includes("--require exe,runtime,zip,installer-input,installer,vsix,npm"));
    assert.ok(artifacts.includes("--require-iscc"));
  });

  it("starts the bundled backend after building the runtime and before the installer", () => {
    const artifacts = jobBlocks(text).get("artifacts");
    const smoke = artifacts.indexOf("node scripts/release/smoke-backend.mjs");
    assert.ok(smoke > artifacts.indexOf("node scripts/release/build-exe.mjs"));
    assert.ok(smoke < artifacts.indexOf("node scripts/release/build-installer.mjs"));
  });
});

describe("release.yml", () => {
  const text = load("release.yml");
  const lines = codeLines(text);
  const code = lines.join("\n");
  const jobs = jobBlocks(text);

  it("has the expected jobs", () => {
    assert.deepEqual([...jobs.keys()], ["build", "github-release", "npm-dry-run", "npm-publish"]);
  });

  it("is triggered by a v*.*.* tag push and a manual dispatch, with no branch trigger", () => {
    assert.ok(code.includes('tags: ["v*.*.*"]'));
    assert.ok(code.includes("workflow_dispatch:"));
    assert.ok(!code.includes("branches:"));
    assert.ok(!code.includes("pull_request"));
    const on = topBlock(text, "on");
    assert.ok(on.includes("push:") && on.includes("workflow_dispatch:"));
    for (const input of ["tag:", "draft_release:", "publish_npm:"]) assert.ok(on.includes(input), input);
    assert.ok(on.includes("required: true"));
    assert.equal(count(code, "default: false"), 2, "draft_release and publish_npm default to false");
  });

  it("does not cancel a release run that is already going", () => {
    assert.deepEqual(topBlock(text, "concurrency"), ["group: release-${{ inputs.tag || github.ref_name }}", "cancel-in-progress: false"]);
  });

  it("every real npm publish line has --provenance, every dry-run line has --dry-run, and publishing happens only in the two npm jobs", () => {
    const publishLines = lines.filter((l) => l.includes("npm publish"));
    assert.ok(publishLines.length > 0);
    for (const l of publishLines) assert.ok(l.includes("--access public"), l);
    for (const l of jobs.get("npm-publish").split("\n").filter((x) => x.includes("npm publish"))) {
      assert.ok(l.includes("--provenance") && !l.includes("--dry-run"), l);
    }
    for (const l of jobs.get("npm-dry-run").split("\n").filter((x) => x.includes("npm publish"))) {
      assert.ok(l.includes("--dry-run") && !l.includes("--provenance"), l);
    }
    for (const [job, block] of jobs) if (!job.startsWith("npm-")) assert.ok(!block.includes("npm publish"), `npm publish in ${job}`);
  });

  it("the dry-run job has no environment, no secret and no id-token, and only reads contents", () => {
    const dry = jobs.get("npm-dry-run");
    assert.ok(!dry.includes("environment:"));
    assert.ok(!dry.includes("secrets."));
    assert.ok(!dry.includes("id-token"));
    assert.ok(!dry.includes("NODE_AUTH_TOKEN"));
    assert.ok(!dry.includes("if: "), "the dry run runs for tag pushes and dispatches alike");
    assert.match(dry, /^ {4}permissions:\n {6}contents: read\n {4}steps:$/m);
  });

  it("the publish job runs only on a manual dispatch with publish_npm, behind the npm environment, and is the only one with id-token: write", () => {
    const pub = jobs.get("npm-publish");
    assert.match(pub, /^ {4}if: github\.event_name == 'workflow_dispatch' && inputs\.publish_npm$/m);
    assert.equal(count(code, "id-token: write"), 1);
    assert.ok(pub.includes("id-token: write"));
    assert.equal(count(code, "environment:"), 1);
    assert.match(pub, /^ {4}environment: npm$/m);
    assert.deepEqual(
      pub
        .split("\n")
        .slice(pub.split("\n").findIndex((l) => l === "    permissions:") + 1)
        .filter((l) => l.startsWith("      ") && !l.startsWith("       "))
        .slice(0, 2)
        .map((l) => l.trim()),
      ["contents: read", "id-token: write"],
    );
  });

  it("the npm token is used only by the publish job, as NODE_AUTH_TOKEN", () => {
    assert.equal(count(code, "secrets.NPM_TOKEN"), 1);
    assert.ok(jobs.get("npm-publish").includes("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}"));
  });

  it("prereleases go to the next tag and publish_npm is an input read once", () => {
    for (const job of ["npm-dry-run", "npm-publish"]) assert.ok(jobs.get(job).includes("extra+=(--tag next)"), job);
    assert.equal(count(code, "publish_npm"), 2, "publish_npm is an input and is read once");
    assert.ok(!/--dry-run=false/.test(code));
  });

  it("only the github-release job can write, and it only creates a draft", () => {
    assert.equal(count(code, "contents: write"), 1);
    const gh = jobs.get("github-release");
    assert.ok(gh.includes("contents: write"));
    assert.ok(gh.includes("if: github.event_name == 'push' || inputs.draft_release"));
    assert.ok(gh.includes("--draft") && gh.includes("--verify-tag"));
    assert.equal(count(code, "gh release"), 1);
    assert.ok(gh.includes("gh release create"));
    for (const word of ["gh release edit", "--draft=false", "--latest", "gh release upload", "gh api"]) assert.ok(!code.includes(word), word);
    assert.ok(!jobs.get("build").includes("permissions:"));
  });

  it("scans without a name secret and requires the installer", () => {
    const build = jobs.get("build");
    assert.ok(!build.includes("--require-denylist"));
    assert.ok(build.includes("--require exe,runtime,zip,installer-input,installer,vsix,npm"));
    assert.ok(build.includes("--require-iscc"));
    assert.ok(build.includes("--require-installer"));
    assert.ok(build.includes("set-version.mjs --check"));
    const smoke = build.indexOf("node scripts/release/smoke-backend.mjs");
    assert.ok(smoke > build.indexOf("node scripts/release/build-exe.mjs"), "the bundled backend is smoke-tested after the exe build");
    assert.ok(!build.includes("ABFC_NAME_DENYLIST"));
  });

  it("checks the tag format before using it", () => {
    assert.ok(code.includes("^v\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$"));
    assert.ok(code.includes("TAG: ${{ inputs.tag || github.ref_name }}"));
  });

  it("uploads the release files and the npm tarballs as workflow artifacts", () => {
    assert.ok(code.includes("name: release-files") && code.includes("name: npm-tarballs"));
    assert.ok(code.includes("path: build/release/github/") && code.includes("path: build/release/npm/"));
    assert.equal(count(code, "if-no-files-found: error"), 2);
  });
});

describe("Inno Setup step", () => {
  function step(name) {
    const text = load(name);
    const start = text.indexOf("      - name: Inno Setup compiler\n");
    assert.ok(start >= 0, `${name}: no Inno Setup step`);
    const end = text.indexOf("\n\n", start);
    return text.slice(start, end);
  }

  it("is the same in both workflows", () => {
    assert.equal(step("ci.yml"), step("release.yml"));
  });

  it("prefers the runner image, falls back to the pinned download and fails loudly without a pin", () => {
    const s = step("ci.yml");
    assert.ok(s.includes("Inno Setup 6\\ISCC.exe"));
    assert.ok(s.includes("fetch-pins.mjs --download --only innosetup"));
    assert.ok(s.includes("release/pins.json has no innosetup pin"));
    assert.ok(s.includes("ABFC_ISCC=$iscc"));
    assert.ok(s.includes("build\\tools\\innosetup"));
  });
});
