import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../src/index.js";
import { ALL_TOOLS, captureDeps, fakeEnvironmentFiles, fakeHost, fixInfo, scriptedBackend } from "./helpers.js";

const EXT = { extProtocol: 1, serverVersion: "fake-1", python: "3.11.9", features: ["reflect", "compile_node_refs", "bp_read_seconds"] };
const CORE = ["staging_sync", "staging_status", "bp_apply", "bp_read", "bp_compile_report", "bp_game_test", "mod_audit"];

test("happy path: every source auto, native pin types, exit 0, output lists sources", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo(), abfc_extensions: EXT }));
  const code = await main(["doctor"], cap.deps);
  const out = cap.text();
  assert.equal(code, 0, out);
  assert.equal(cap.started.count, 1);
  assert.match(out, /editor root\s+C:\\Epic\\ModEdit_X1.*\[auto\]/);
  assert.match(out, /documents\s+C:\\Users\\Jane\\Documents\s+\[auto\]/);
  assert.match(out, /mod folder\s+.*TestMod\s+\[auto\]/);
  assert.match(out, /python\s+C:\\Python311\\python\.exe\s+\(Python 3\.11\)\s+\[auto\]/);
  assert.match(out, /backend folder\s+C:\\Backend\\mcp\s+\[env\]/);
  assert.match(out, /headless folder\s+C:\\abfc-headless\s+\[env\]/);
  assert.match(out, /wildcard pin types: native/);
  assert.match(out, /cast Object: typed by backend/);
  assert.match(out, /backend array: true, map: true, set: false; abfc array: true, map: true, set: false, struct: false/);
  assert.match(out, /extensions: reflect, compile_node_refs, bp_read_seconds/);
  assert.doesNotMatch(out, /error ABFC/);
});

test("second account: a space in LOCALAPPDATA gives ABFC1012 with the advice and exit 2; the backend is not started", async () => {
  const fake = fakeEnvironmentFiles({
    username: "Jane Doe",
    localAppData: "C:\\Users\\Jane Doe\\AppData\\Local",
    documents: "D:\\Redirected\\Docs",
  });
  const cap = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo(), abfc_extensions: EXT }));
  const code = await main(["doctor"], cap.deps);
  const out = cap.text();
  assert.equal(code, 2, out);
  assert.match(out, /error ABFC1012/);
  assert.match(out, /C:\\Users\\Jane Doe\\AppData\\Local\\/);
  assert.match(out, /C:\\abfc-headless/);
  assert.equal(cap.started.count, 0);
});

test("second account with ABF_HEADLESS_DIR set: exit 0 and the redirected Documents folder is shown with source auto", async () => {
  const fake = fakeEnvironmentFiles({
    username: "Jane Doe",
    localAppData: "C:\\Users\\Jane Doe\\AppData\\Local",
    documents: "D:\\Redirected\\Docs",
    headlessDir: "C:\\abfc-headless",
  });
  const cap = captureDeps(fake, async () =>
    scriptedBackend(ALL_TOOLS, { backend_info: fixInfo({ documentsDir: "D:\\Redirected\\Docs" }), abfc_extensions: EXT }),
  );
  const code = await main(["doctor"], cap.deps);
  const out = cap.text();
  assert.equal(code, 0, out);
  assert.match(out, /documents\s+D:\\Redirected\\Docs\s+\[auto\]/);
  assert.match(out, /mods folder\s+D:\\Redirected\\Docs\\.*\[auto\]/);
  assert.doesNotMatch(out, /ABFC1012/);
});

test("backend without backend_info: warning ABFC4012, fallback pin types, exit 0", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () => scriptedBackend(CORE, {}));
  const code = await main(["doctor"], cap.deps);
  const out = cap.text();
  assert.equal(code, 0, out);
  assert.match(out, /warning ABFC4012/);
  assert.match(out, /wildcard pin types: fallback \(two-phase raw graph, \+10-20 s per build\)/);
  assert.doesNotMatch(out, /cast Object: typed by backend/);
  assert.match(out, /containers: backend not reported;/);
});

test("backend_info protocol 0: ABFC4001 and exit 2", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo({ protocol: 0 }), abfc_extensions: EXT }));
  const code = await main(["doctor"], cap.deps);
  const out = cap.text();
  assert.equal(code, 2, out);
  assert.match(out, /error ABFC4001: .*protocol 0.*abfc needs protocol >= 1/);
});

test("backend 2.3.0: warning ABFC4014, exit 0", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () =>
    scriptedBackend(ALL_TOOLS, { backend_info: fixInfo({ serverVersion: "2.3.0" }), abfc_extensions: EXT }),
  );
  const code = await main(["doctor"], cap.deps);
  const out = cap.text();
  assert.equal(code, 0, out);
  assert.match(out, /warning ABFC4014: .*server 2\.3\.0; abfc needs 2\.4\.0 or newer/);
  assert.match(out, /\(minimum 2\.4\.0\)/);
  assert.doesNotMatch(out, /ABFC4012|ABFC4001/);
});

test("backend 2.4.0 and v2.10.1: no ABFC4014; the minimum is printed", async () => {
  for (const serverVersion of ["2.4.0", "v2.10.1"]) {
    const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
    const cap = captureDeps(fake, async () =>
      scriptedBackend(ALL_TOOLS, { backend_info: fixInfo({ serverVersion }), abfc_extensions: EXT }),
    );
    const code = await main(["doctor"], cap.deps);
    const out = cap.text();
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /ABFC4014/);
    assert.match(out, /\(minimum 2\.4\.0\)/);
  }
});

test("backend without bp_apply: ABFC4001 and exit 2", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const tools = ALL_TOOLS.filter((t) => t !== "bp_apply");
  const cap = captureDeps(fake, async () => scriptedBackend(tools, { backend_info: fixInfo(), abfc_extensions: EXT }));
  const code = await main(["doctor"], cap.deps);
  const out = cap.text();
  assert.equal(code, 2, out);
  assert.match(out, /error ABFC4001: .*bp_apply/);
});

test("backend_info with pinTypes false: fallback", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo({ pinTypes: false }), abfc_extensions: EXT }));
  const code = await main(["doctor"], cap.deps);
  assert.equal(code, 0, cap.text());
  assert.match(cap.text(), /wildcard pin types: fallback/);
});

test("a backend that fails to start is reported as ABFC4002 (exit 2), not thrown", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () => {
    throw new Error("spawn failed");
  });
  const code = await main(["doctor"], cap.deps);
  assert.equal(code, 2, cap.text());
  assert.match(cap.text(), /error ABFC4002: could not query the backend: spawn failed/);
});

test("--json prints one document with ok, diagnostics and result", async () => {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const cap = captureDeps(fake, async () => scriptedBackend(CORE, {}));
  const code = await main(["doctor", "--json"], cap.deps);
  assert.equal(code, 0, cap.text());
  assert.equal(cap.lines.length, 1);
  const doc = JSON.parse(cap.lines[0]!) as { command: string; ok: boolean; diagnostics: Array<{ code: string }>; result: { backend: unknown } };
  assert.equal(doc.command, "doctor");
  assert.equal(doc.ok, true);
  assert.ok(doc.diagnostics.some((d) => d.code === "ABFC4012"));
  assert.ok(doc.result.backend);
});

test("a project inside a mod folder is refused with ABFC1020 (exit 3)", async () => {
  const fake = fakeEnvironmentFiles({
    extraFiles: { "C:\\Work\\Mod\\Thing.uplugin": "{}" },
  });
  // move the project under the folder that holds a .uplugin
  const files = { ...fake.files };
  delete files[`${fake.projectDir}\\abf.config.json`];
  files["C:\\Work\\Mod\\proj\\abf.config.json"] = fake.files[`${fake.projectDir}\\abf.config.json`]!;
  const moved = { ...fake, files, projectDir: "C:\\Work\\Mod\\proj", host: () => fakeHost(files, fake.run, fake.env) };
  const cap = captureDeps(moved, async () => scriptedBackend(CORE, {}));
  const code = await main(["doctor"], cap.deps);
  assert.equal(code, 3, cap.text());
  assert.match(cap.text(), /error ABFC1020/);
  assert.equal(cap.started.count, 0);
});

test("an unknown command and a bad option exit 2", async () => {
  const fake = fakeEnvironmentFiles();
  const cap = captureDeps(fake, async () => scriptedBackend(CORE, {}));
  assert.equal(await main(["frobnicate"], cap.deps), 2);
  assert.equal(await main(["doctor", "--nope"], cap.deps), 2);
  assert.match(cap.text(), /unknown or not yet available command "frobnicate"/);
});
