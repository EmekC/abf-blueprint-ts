import { test } from "node:test";
import assert from "node:assert/strict";
import { findAbfc, projectDirOf, type DiscoverInput } from "../src/discover.js";

// Windows paths below are plain strings; the module under test joins them with path.win32 whatever the host is.
function input(files: string[], over: Partial<DiscoverInput> = {}): DiscoverInput {
  const set = new Set(files);
  return {
    env: {},
    workspaceFolders: [],
    platform: "win32",
    isFile: (f) => set.has(f),
    ...over,
  };
}

const BIN = "node_modules\\@abfc\\cli\\dist\\src\\bin.js";

test("abfc.path wins over everything and an executable is started directly", () => {
  const i = input(["C:\\tools\\abfc.exe", "C:\\bin\\abfc.exe"], {
    abfcPath: "C:\\tools\\abfc.exe",
    env: { PATH: "C:\\bin" },
  });
  const r = findAbfc(i);
  assert.deepEqual(r.launch, { command: "C:\\tools\\abfc.exe", args: [], source: "abfc.path" });
  assert.deepEqual(r.tried, ["C:\\tools\\abfc.exe"]);
});

test("a .js abfc.path starts with node", () => {
  const r = findAbfc(input(["C:\\src\\bin.js"], { abfcPath: "C:\\src\\bin.js" }));
  assert.deepEqual(r.launch, { command: "node", args: ["C:\\src\\bin.js"], source: "abfc.path" });
  const mjs = findAbfc(input(["C:\\src\\bin.mjs"], { abfcPath: "C:\\src\\bin.mjs" }));
  assert.equal(mjs.launch?.command, "node");
});

test("a missing abfc.path falls through and is listed in tried", () => {
  const r = findAbfc(input(["C:\\bin\\abfc.exe"], { abfcPath: "C:\\gone\\abfc.exe", env: { PATH: "C:\\bin" } }));
  assert.equal(r.launch?.source, "PATH");
  assert.equal(r.tried[0], "C:\\gone\\abfc.exe");
  assert.ok(r.tried.includes("C:\\bin\\abfc.exe"));
});

test("abfc.exe on PATH, in PATH order", () => {
  const r = findAbfc(input(["C:\\two\\abfc.exe", "C:\\three\\abfc.exe"], { env: { PATH: "C:\\one;C:\\two;C:\\three" } }));
  assert.deepEqual(r.launch, { command: "C:\\two\\abfc.exe", args: [], source: "PATH" });
  assert.deepEqual(r.tried, ["C:\\one\\abfc.exe", "C:\\two\\abfc.exe"]);
});

test("the Path key, quoted entries and empty entries", () => {
  const r = findAbfc(input(["C:\\Program Files\\abfc\\abfc.exe"], { env: { Path: ';"C:\\Program Files\\abfc";;' } }));
  assert.deepEqual(r.launch, { command: "C:\\Program Files\\abfc\\abfc.exe", args: [], source: "PATH" });
});

test("an npm global install runs bin.js with node", () => {
  const bin = `C:\\npm\\${BIN}`;
  const r = findAbfc(input(["C:\\npm\\abfc.cmd", bin], { env: { PATH: "C:\\npm" } }));
  assert.deepEqual(r.launch, { command: "node", args: [bin], source: "npm global" });
});

test("abfc.cmd without bin.js beside it is skipped", () => {
  const r = findAbfc(input(["C:\\npm\\abfc.cmd"], { env: { PATH: "C:\\npm" } }));
  assert.equal(r.launch, null);
  assert.ok(r.tried.includes("C:\\npm\\abfc.cmd"));
  assert.ok(r.tried.includes(`C:\\npm\\${BIN}`));
});

test("an abfc.path naming a .cmd shim is mapped to the bin.js beside it and started with node", () => {
  const bin = `C:\\npm\\${BIN}`;
  for (const shim of ["C:\\npm\\abfc.cmd", "C:\\npm\\abfc.BAT"]) {
    const r = findAbfc(input([shim, bin], { abfcPath: shim }));
    assert.deepEqual(r.launch, { command: "node", args: [bin], source: "abfc.path" });
  }
});

test("an abfc.path naming a .cmd shim without bin.js is not started and says what to do", () => {
  const r = findAbfc(input(["C:\\npm\\abfc.cmd", "C:\\bin\\abfc.exe"], { abfcPath: "C:\\npm\\abfc.cmd", env: { PATH: "C:\\bin" } }));
  assert.equal(r.launch, null);
  assert.match(r.message ?? "", /abfc\.exe or bin\.js/);
  assert.ok(r.tried.includes(`C:\\npm\\${BIN}`));
});

test("an untrusted workspace ignores abfc.path, the workspace bin.js and abfc.cliPath", () => {
  const files = ["C:\\a\\abfc.exe", `C:\\w\\${BIN}`, "C:\\cli\\bin.js", "C:\\b\\abfc.exe"];
  const base = { abfcPath: "C:\\a\\abfc.exe", workspaceFolders: ["C:\\w"], cliPath: "C:\\cli\\bin.js" };
  const only = findAbfc(input(files.slice(0, 3), { ...base, trusted: false }));
  assert.equal(only.launch, null);
  assert.deepEqual(only.tried, []);
  const machine = findAbfc(input(files, { ...base, env: { PATH: "C:\\b" }, trusted: false }));
  assert.deepEqual(machine.launch, { command: "C:\\b\\abfc.exe", args: [], source: "PATH" });
  assert.equal(findAbfc(input(files, { ...base, env: { PATH: "C:\\b" }, trusted: true })).launch?.source, "abfc.path");
});

test("the installer folder", () => {
  const exe = "C:\\Users\\Someone\\AppData\\Local\\Programs\\abfc\\abfc.exe";
  const r = findAbfc(input([exe], { env: { LOCALAPPDATA: "C:\\Users\\Someone\\AppData\\Local" } }));
  assert.deepEqual(r.launch, { command: exe, args: [], source: "installer" });
});

test("a workspace folder with a source install, then abfc.cliPath", () => {
  const ws = `C:\\work\\mod\\${BIN}`;
  const files = [ws, "C:\\clone\\packages\\cli\\dist\\src\\bin.js"];
  const a = findAbfc(input(files, { workspaceFolders: ["C:\\work\\other", "C:\\work\\mod"], cliPath: "C:\\clone\\packages\\cli\\dist\\src\\bin.js" }));
  assert.deepEqual(a.launch, { command: "node", args: [ws], source: "workspace" });
  const b = findAbfc(input(files.slice(1), { workspaceFolders: ["C:\\work\\mod"], cliPath: "C:\\clone\\packages\\cli\\dist\\src\\bin.js" }));
  assert.deepEqual(b.launch, { command: "node", args: ["C:\\clone\\packages\\cli\\dist\\src\\bin.js"], source: "abfc.cliPath" });
});

test("each source loses to the one before it", () => {
  const files = [
    "C:\\a\\abfc.exe",
    "C:\\b\\abfc.exe",
    `C:\\c\\${BIN}`,
    "C:\\c\\abfc.cmd",
    "C:\\L\\Programs\\abfc\\abfc.exe",
    `C:\\w\\${BIN}`,
    "C:\\cli\\bin.js",
  ];
  const base = { env: { PATH: "C:\\b;C:\\c", LOCALAPPDATA: "C:\\L" }, workspaceFolders: ["C:\\w"], cliPath: "C:\\cli\\bin.js" };
  assert.equal(findAbfc(input(files, { ...base, abfcPath: "C:\\a\\abfc.exe" })).launch?.source, "abfc.path");
  assert.equal(findAbfc(input(files, base)).launch?.source, "PATH");
  assert.equal(findAbfc(input(files.filter((f) => f !== "C:\\b\\abfc.exe"), base)).launch?.source, "npm global");
  assert.equal(findAbfc(input(files.filter((f) => !f.startsWith("C:\\b") && !f.startsWith("C:\\c")), base)).launch?.source, "installer");
  assert.equal(findAbfc(input(files.slice(5), base)).launch?.source, "workspace");
  assert.equal(findAbfc(input(files.slice(6), base)).launch?.source, "abfc.cliPath");
});

test("posix uses abfc, splits PATH on colons and skips the installer and shim steps", () => {
  const r = findAbfc({
    env: { PATH: "/usr/bin:/opt/abfc", LOCALAPPDATA: "/ignored" },
    workspaceFolders: [],
    platform: "linux",
    isFile: (f) => f === "/opt/abfc/abfc",
  });
  assert.deepEqual(r.launch, { command: "/opt/abfc/abfc", args: [], source: "PATH" });
  const none = findAbfc({ env: { PATH: "/usr/bin", LOCALAPPDATA: "/ignored" }, workspaceFolders: [], platform: "linux", isFile: () => false });
  assert.equal(none.launch, null);
  assert.deepEqual(none.tried, ["/usr/bin/abfc"]);
});

test("nothing found gives null and every checked path", () => {
  const r = findAbfc(
    input([], {
      abfcPath: "C:\\x\\abfc.exe",
      env: { PATH: "C:\\bin", LOCALAPPDATA: "C:\\L" },
      workspaceFolders: ["C:\\w"],
      cliPath: "C:\\cli\\bin.js",
    }),
  );
  assert.equal(r.launch, null);
  assert.deepEqual(r.tried, [
    "C:\\x\\abfc.exe",
    "C:\\bin\\abfc.exe",
    "C:\\bin\\abfc.cmd",
    "C:\\L\\Programs\\abfc\\abfc.exe",
    `C:\\w\\${BIN}`,
    "C:\\cli\\bin.js",
  ]);
});

test("projectDirOf walks up to the folder with abf.config.json", () => {
  const files = new Set(["C:\\proj\\abf.config.json"]);
  const isFile = (f: string): boolean => files.has(f);
  assert.equal(projectDirOf("C:\\proj\\src\\Relays\\A.ts", isFile, "win32"), "C:\\proj");
  assert.equal(projectDirOf("C:\\proj\\A.ts", isFile, "win32"), "C:\\proj");
  assert.equal(projectDirOf("C:\\other\\A.ts", isFile, "win32"), null);
  const posix = new Set(["/p/abf.config.json"]);
  assert.equal(projectDirOf("/p/src/A.ts", (f) => posix.has(f), "linux"), "/p");
  assert.equal(projectDirOf("/q/src/A.ts", (f) => posix.has(f), "linux"), null);
});
