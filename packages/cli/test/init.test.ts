import { test } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { main } from "../src/index.js";
import { ALL_TOOLS, fakeEnvironmentFiles, fixInfo, mutableCapture, scriptedBackend } from "./helpers.js";
import type { FakeEnvironment, MutableCaptured } from "./helpers.js";

const EXT = { extProtocol: 1, serverVersion: "fake-1", python: "3.11.9", features: ["reflect", "compile_node_refs", "bp_read_seconds"] };
const USER_CONFIG = "C:\\Users\\Jane\\AppData\\Roaming\\abfc\\config.json";
const TARGET = "C:\\Work\\newproj";

interface Setup {
  fake: FakeEnvironment;
  cap: MutableCaptured;
  modsDir: string;
}

/** A machine with an editor install and a mods folder holding ModA, ModB and a folder that is not a mod; no project yet. */
function setup(extra: Record<string, string> = {}, remove?: RegExp): Setup {
  const fake = fakeEnvironmentFiles({ headlessDir: "C:\\abfc-headless" });
  const modsDir = win32.dirname(fake.modDir);
  delete fake.files[win32.join(fake.projectDir, "abf.config.json")];
  delete fake.files[win32.join(fake.modDir, "TestMod.uplugin")];
  fake.files[win32.join(modsDir, "ModA", "ModA.uplugin")] = JSON.stringify({ FriendlyName: "Mod A" });
  fake.files[win32.join(modsDir, "ModA", "Content", "Thing.uasset")] = "";
  fake.files[win32.join(modsDir, "ModB", "ModB.uplugin")] = "{}";
  fake.files[win32.join(modsDir, "NotAMod", "readme.txt")] = "x";
  Object.assign(fake.files, extra);
  if (remove !== undefined) for (const k of Object.keys(fake.files)) if (remove.test(k)) delete fake.files[k];
  fake.env.ABFC_USER_CONFIG = USER_CONFIG;
  const cap = mutableCapture(fake, async () => scriptedBackend(ALL_TOOLS, { backend_info: fixInfo(), abfc_extensions: EXT }));
  return { fake, cap, modsDir };
}

const rel = (p: string): string => win32.relative(TARGET, p).replace(/\\/g, "/");
const read = (s: Setup, ...parts: string[]): string => s.fake.files[win32.join(TARGET, ...parts)] as string;

test("init --mod moda --yes writes the project files, the sample and the user config", async () => {
  const s = setup();
  const code = await main(["init", TARGET, "--mod", "moda", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  const inTarget = s.cap.writes.filter((p) => p !== USER_CONFIG).map(rel).sort();
  assert.deepEqual(inTarget, [
    ".gitignore",
    ".vscode/extensions.json",
    ".vscode/tasks.json",
    "abf.config.json",
    "src/Samples/BP_HelloAbfc.test.ts",
    "src/Samples/BP_HelloAbfc.ts",
    "tsconfig.json",
  ]);
  assert.deepEqual(s.cap.writes.filter((p) => !p.startsWith(TARGET)), [USER_CONFIG]);

  const cfg = JSON.parse(read(s, "abf.config.json")) as {
    schemaVersion: number;
    mod: { name: string };
    sourceRoot: string;
    classManager: { table: string };
    stubs: { scriptClasses: string[]; modAssets: string; classes: string[] };
  };
  assert.equal(cfg.schemaVersion, 2);
  assert.equal(cfg.mod.name, "ModA", "the folder's spelling");
  assert.equal(cfg.sourceRoot, "src");
  assert.equal(cfg.classManager.table, "DataTables/DT_ClassManager");
  assert.equal(cfg.stubs.scriptClasses.length, 15);
  assert.equal(cfg.stubs.modAssets, "all");
  assert.match(read(s, "tsconfig.json"), /"extends": "\.\/\.abfc\/tsconfig\.paths\.json"/);
  assert.doesNotMatch(read(s, "tsconfig.json"), /plugins/);
  assert.match(read(s, ".gitignore"), /^\.abfc\/stubs\/$/m);
  assert.match(read(s, ".vscode", "tasks.json"), /abfc check --watch/);
  assert.match(read(s, ".vscode", "extensions.json"), /abfc\.abfc-vscode/);
  assert.match(read(s, "src", "Samples", "BP_HelloAbfc.ts"), /@blueprint\(\)/);
  assert.match(read(s, "src", "Samples", "BP_HelloAbfc.test.ts"), /equals\(2\)/);

  const user = JSON.parse(s.fake.files[USER_CONFIG] as string) as { schemaVersion: number; editor: { root: string }; modsDir: string };
  assert.equal(user.schemaVersion, 2);
  assert.equal(user.editor.root, s.fake.editorRoot);
  assert.equal(user.modsDir, s.modsDir);
  assert.match(s.cap.text(), /written\s+abf\.config\.json/);
  assert.match(s.cap.text(), /abfc doctor/);
});

test("init twice with the same answers changes nothing", async () => {
  const s = setup();
  assert.equal(await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  const before = JSON.stringify(s.fake.files);
  s.cap.writes.length = 0;
  s.cap.lines.length = 0;
  const code = await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  assert.deepEqual(s.cap.writes, []);
  assert.equal(JSON.stringify(s.fake.files), before);
  assert.doesNotMatch(s.cap.text(), /\bwritten\b|\bupdated\b/);
  assert.match(s.cap.text(), /kept\s+abf\.config\.json/);
  assert.match(s.cap.text(), /kept\s+src\/Samples\/BP_HelloAbfc\.ts/);
});

test("init without --mod on a linked project keeps the project's mod", async () => {
  const s = setup();
  assert.equal(await main(["init", TARGET, "--mod", "ModB", "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  s.cap.writes.length = 0;
  assert.equal(await main(["init", TARGET, "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  assert.deepEqual(s.cap.writes, []);
  assert.equal((JSON.parse(read(s, "abf.config.json")) as { mod: { name: string } }).mod.name, "ModB");
});

test("init --mod other --yes switches the mod of a schema-2 project (updated)", async () => {
  const s = setup();
  assert.equal(await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  s.cap.lines.length = 0;
  assert.equal(await main(["init", TARGET, "--mod", "modb", "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  assert.equal((JSON.parse(read(s, "abf.config.json")) as { mod: { name: string } }).mod.name, "ModB");
  assert.match(s.cap.text(), /updated\s+abf\.config\.json/);
});

test("an unknown mod gives ABFC1042 with the mods found and writes nothing", async () => {
  const s = setup();
  const code = await main(["init", TARGET, "--mod", "Nope", "--yes", "--no-stubs"], s.cap.deps);
  const out = s.cap.text();
  assert.equal(code, 1, out);
  assert.match(out, /error ABFC1042/);
  assert.match(out, /ModA\s+"Mod A", 1 assets/);
  assert.match(out, /ModB/);
  assert.doesNotMatch(out, /NotAMod/);
  assert.deepEqual(s.cap.writes, []);
});

test("an empty mods folder gives ABFC1044", async () => {
  const s = setup({}, /\\(ModA|ModB)\\/);
  const code = await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 1, s.cap.text());
  assert.match(s.cap.text(), /error ABFC1044/);
});

test("a target inside a mod folder gives ABFC1020 (exit 3) and writes nothing", async () => {
  const s = setup();
  const code = await main(["init", win32.join(s.modsDir, "ModA", "ts"), "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 3, s.cap.text());
  assert.match(s.cap.text(), /error ABFC1020/);
  assert.deepEqual(s.cap.writes, []);
});

test("a target inside another project gives ABFC1040", async () => {
  const s = setup({ "C:\\Work\\outer\\abf.config.json": '{"mod":{"name":"ModA"}}' });
  const code = await main(["init", "C:\\Work\\outer\\inner", "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 1, s.cap.text());
  assert.match(s.cap.text(), /error ABFC1040/);
  assert.deepEqual(s.cap.writes, []);
});

test("without a terminal and without --yes it is ABFC1041; --yes without --mod on a new folder too", async () => {
  const s = setup();
  const code = await main(["init", TARGET, "--mod", "ModA", "--no-stubs"], s.cap.deps);
  assert.equal(code, 1, s.cap.text());
  assert.match(s.cap.text(), /error ABFC1041/);
  assert.match(s.cap.text(), /--mod <name> --yes/);
  s.cap.lines.length = 0;
  assert.equal(await main(["init", TARGET, "--yes", "--no-stubs"], s.cap.deps), 1);
  assert.match(s.cap.text(), /error ABFC1041/);
  assert.deepEqual(s.cap.writes, []);
});

test("a schema-1 project is upgraded with a .v1.bak and its machine keys move to the user config", async () => {
  const v1 = JSON.stringify({
    mod: { name: "ModA" },
    modsDir: "D:\\OtherMods",
    stubs: { classes: [], scriptClasses: ["/Script/Engine.Actor"], modAssets: ["/ModA/Relays/BP_X"] },
    backend: { kind: "bp_apply", minProtocol: 1 },
  });
  const s = setup({ [win32.join(TARGET, "abf.config.json")]: v1, [win32.join(TARGET, "src", "A.ts")]: "export {};\n" });
  // The old project config named the mods folder; make it exist so doctor can still find the mod.
  s.fake.files[win32.join("D:\\OtherMods", "ModA", "ModA.uplugin")] = "{}";
  const code = await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  assert.equal(read(s, "abf.config.json.v1.bak"), v1);
  const cfg = JSON.parse(read(s, "abf.config.json")) as { schemaVersion: number; stubs: { modAssets: string[] }; modsDir?: string };
  assert.equal(cfg.schemaVersion, 2);
  assert.deepEqual(cfg.stubs.modAssets, ["Relays/BP_X"]);
  assert.equal(cfg.modsDir, undefined);
  const user = JSON.parse(s.fake.files[USER_CONFIG] as string) as { modsDir: string };
  assert.equal(user.modsDir, "D:\\OtherMods");
  assert.match(s.cap.text(), /updated\s+abf\.config\.json/);
  assert.equal(s.fake.files[win32.join(TARGET, "src", "Samples", "BP_HelloAbfc.ts")], undefined, "src holds a .ts file: no sample");
  assert.doesNotMatch(s.cap.text(), /ABFC1031/);
});

test("an existing user config is merged: other keys stay and a .bak is written", async () => {
  const s = setup({ [USER_CONFIG]: JSON.stringify({ custom: 1, headlessDir: "C:\\abfc-headless" }) });
  const code = await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  const user = JSON.parse(s.fake.files[USER_CONFIG] as string) as Record<string, unknown>;
  assert.equal(user.custom, 1);
  assert.equal(user.headlessDir, "C:\\abfc-headless");
  assert.equal(user.schemaVersion, 2);
  assert.equal(s.fake.files[`${USER_CONFIG}.bak`], JSON.stringify({ custom: 1, headlessDir: "C:\\abfc-headless" }));
});

test("an existing tsconfig with the ts-plugin and no extends is left alone with ABFC1043 warnings", async () => {
  const tsconfig = '{ "compilerOptions": { "plugins": [{ "name": "@abfc/ts-plugin" }] } }\n';
  const s = setup({ [win32.join(TARGET, "tsconfig.json")]: tsconfig });
  const code = await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  assert.equal(read(s, "tsconfig.json"), tsconfig);
  assert.ok(!s.cap.writes.some((p) => p.endsWith("tsconfig.json")));
  const out = s.cap.text();
  assert.match(out, /warning ABFC1043: tsconfig\.json does not extend/);
  assert.match(out, /warning ABFC1043: tsconfig\.json still loads @abfc\/ts-plugin/);
  assert.match(out, /kept\s+tsconfig\.json/);
});

test("an existing .gitignore only gets the missing lines appended", async () => {
  const s = setup({ [win32.join(TARGET, ".gitignore")]: "dist/\n.abfc/stubs/" });
  assert.equal(await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  const lines = read(s, ".gitignore").split("\n");
  assert.deepEqual(lines.slice(0, 2), ["dist/", ".abfc/stubs/"]);
  assert.equal(lines.filter((l) => l === ".abfc/stubs/").length, 1);
  assert.ok(lines.includes(".abfc/tsconfig.paths.json"));
  assert.ok(lines.includes(".abfc/reports/"));
  assert.match(s.cap.text(), /updated\s+\.gitignore/);
});

test("--json prints one document with the result shape", async () => {
  const s = setup();
  const code = await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs", "--json"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  const doc = JSON.parse(s.cap.text()) as {
    command: string;
    ok: boolean;
    result: {
      project: string;
      mod: string;
      modsDir: string;
      editorRoot: string;
      files: Array<{ path: string; action: string }>;
      userConfig: { path: string; keys: string[] };
      stubs: number | null;
      doctor: number;
    };
  };
  assert.equal(doc.command, "init");
  assert.equal(doc.ok, true);
  assert.equal(doc.result.project, TARGET);
  assert.equal(doc.result.mod, "ModA");
  assert.equal(doc.result.modsDir, s.modsDir);
  assert.equal(doc.result.editorRoot, s.fake.editorRoot);
  assert.equal(doc.result.stubs, null);
  assert.equal(doc.result.doctor, 0);
  assert.equal(doc.result.userConfig.path, USER_CONFIG);
  assert.deepEqual(doc.result.userConfig.keys, ["schemaVersion", "editor.root", "modsDir"]);
  assert.ok(doc.result.files.every((f) => f.action === "written"));
  assert.ok(doc.result.files.some((f) => f.path === "abf.config.json"));
});
