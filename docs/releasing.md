# Releasing abfc

This page is for maintainers. Agents and automation never push, tag, release or publish on their own: every step that leaves the machine is done by a person.

## What CI does

Two workflows live in `.github/workflows/`. Neither one publishes anything on a push or a pull request.

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `ci.yml` | pull requests, pushes to `main`, manual dispatch | Job `test`: build and `npm test` on Node 24 and on the pinned Node 26.7.0, plus `pack-npm.mjs --dry-run`. Job `artifacts`: builds `abfc.exe`, the runtime, the zip, the `.vsix`, the installer and the npm tarballs at the package version, runs `inspect.mjs` and the artifact scan, and keeps the files for 3 days as the `ci-artifacts` workflow artifact. Permissions: `contents: read`. |
| `release.yml` | a tag push `v*.*.*`, manual dispatch | Job `build`: checks the tag against `set-version.mjs --check`, builds, tests, scans with `--require-denylist`, stages `build/release/github/` (files, `SHA256SUMS.txt`, `release-notes.md`). Job `github-release` (tag push, or dispatch with `draft_release`): creates a draft GitHub release. Job `npm`: runs `npm publish --dry-run` for every package, and a real `npm publish --provenance` only on a manual dispatch with `publish_npm: true`. |

Pull requests from forks have no secrets. The scan then uses the committed guard words only and prints a notice; the release workflow refuses to run without the name denylist.

## One-time setup

1. Backend: merge the backend branch that holds the bundled backend, tag it, push, and set `backend.tag` in `release/pins.json` (the commit and the file hash are already pinned). The `artifacts` job and the release build check out the pinned commit of the backend repository; they fail until that commit is reachable on GitHub. If the backend repository is private, give the workflows a read token for it.
2. Repository secret `ABFC_NAME_DENYLIST`: one mod name per line. It is read by the scan step only, through an `env:` mapping, and is never printed (name hits show `denylist entry #n`, not the name).
3. npm: create the `@abfc` scope or organisation on npmjs.com. In the repository settings create an environment named `npm`, add required reviewers, and add the secret `NPM_TOKEN` (a granular token that can publish the `@abfc/*` packages) to that environment only.
4. Inno Setup: the Windows runner image normally has Inno Setup 6, and the workflows use `ISCC.exe` from `Program Files (x86)` and print its banner. If a future image drops it, the workflows fall back to the download pinned in `release/pins.json` (`innosetup`, installed under `build/tools/`). That pin is empty today, so the step fails with a clear message instead of building without an installer. Fill the pin with `node scripts/release/fetch-pins.mjs --download --only innosetup --innosetup-version <x.y.z> --record` (it fills the version and URL, then records the hash after the download) if that happens.

## Releasing a version

1. Choose the version. Run `node scripts/release/set-version.mjs <version>` (for example `1.0.1` or `1.1.0-rc.1`); it updates every package, the intra-repository dependencies, the lock file and `packages/cli/src/version.ts`. `set-version.mjs --check <version>` verifies it.
2. Edit `CHANGELOG.md`: move the entries into a `## [<version>] - <date>` section. `stage-github.mjs` takes the release notes from that section (a prerelease falls back to its release section).
3. Open a pull request. CI must be green, including the `artifacts` job (a full build with the scan).
4. Merge to `main`.
5. Tag the merge commit yourself: `git tag v<version>` and `git push origin v<version>`. The tag must equal `v` plus the package version, otherwise the `build` job stops at the version check.
6. The tag push starts `release.yml`. It creates a draft GitHub release with the exe, the installer, the zip, the `.vsix`, `SHA256SUMS.txt` and the changelog section. The npm job also starts; it waits for approval of the `npm` environment and then does a dry run only.
7. Check the draft: compare the files against `SHA256SUMS.txt`, run the installer on a clean machine or virtual machine (SmartScreen prompt, PATH, the VS Code extension task, `abfc --version`), and unzip the zip once. The files are unsigned.
8. Publish the draft on GitHub (a person clicks the button).
9. Publish to npm: start `release.yml` by hand (Actions, Release, Run workflow) with `tag` set to the same tag and `publish_npm` ticked, approve the `npm` environment, and watch the packages go out in dependency order with provenance. Prerelease versions are published under the `next` dist-tag.

If a build fails after the tag was pushed, fix forward with a new version. Do not move a published tag.

## Pins

- Node: `release/pins.json` pins the Node build that hosts the exe. 26.7.0 is not a long-term-support build; re-pin it to the current LTS patch before the first stable release (edit the `node` entry of `release/pins.json` and run `fetch-pins.mjs --download --only node-shasums,node-license,node-exe --record`; the download is about 100 MB).
- Backend: see the one-time setup. Changing the backend commit changes the bundled files hash; `build-exe.mjs --record` updates it.
- GitHub Actions: the workflows reference actions by `@v4` tags. Re-pin them to full commit SHAs (keep the tag as a trailing comment) and let a dependency update tool keep them current. The workflow test accepts either form.

## Checks that run without CI

These need only a build: `npm run build && npm test`, `node scripts/release/set-version.mjs --check <version>`, `node scripts/release/pack-npm.mjs`, `node scripts/release/inspect.mjs --version <version>`, and `node scripts/release/scan-artifacts.mjs --version <version> --denylist <file>` with a denylist file kept outside the repository. `scripts/release/test/workflows.test.mjs` checks the safety properties of both workflow files as text: nothing publishes on a push or pull request, permissions are minimal, the npm job sits behind the `npm` environment with `id-token: write` and `--provenance`, secrets never appear in a script line. `actionlint` is not part of the repository; run it yourself after editing a workflow.
