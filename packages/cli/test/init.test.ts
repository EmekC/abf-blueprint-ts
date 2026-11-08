import { test } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";
import { loadProfile } from "@abfc/env";
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
    ".abfc/tags.d.ts",
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
  assert.deepEqual(cfg.stubs.scriptClasses, [], "the default set is added by abfc stubs, not written to the config");
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

test("a schema-1 upgrade keeps mod.dir and headlessDir in the project config (init never writes them to the user config)", async () => {
  const v1 = JSON.stringify({
    mod: { name: "ModA", dir: "D:\\Custom\\ModA" },
    headlessDir: "C:\\abfc-headless",
    modsDir: "D:\\OtherMods",
    stubs: { classes: [], scriptClasses: [], modAssets: "all" },
  });
  const s = setup({ [win32.join(TARGET, "abf.config.json")]: v1, [win32.join(TARGET, "src", "A.ts")]: "export {};\n" });
  s.fake.files[win32.join("D:\\OtherMods", "ModA", "ModA.uplugin")] = "{}";
  const code = await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  const cfg = JSON.parse(read(s, "abf.config.json")) as { schemaVersion: number; mod: { name: string; dir?: string }; headlessDir?: string; modsDir?: string };
  assert.equal(cfg.schemaVersion, 2);
  assert.equal(cfg.mod.dir, "D:\\Custom\\ModA");
  assert.equal(cfg.headlessDir, "C:\\abfc-headless");
  assert.equal(cfg.modsDir, undefined, "modsDir moved to the user config");
  const user = JSON.parse(s.fake.files[USER_CONFIG] as string) as Record<string, unknown>;
  assert.equal(user.modsDir, "D:\\OtherMods");
  assert.equal(user.headlessDir, undefined);
  assert.equal(user.mod, undefined);
  assert.doesNotMatch(s.cap.text(), /removed from/);
});

test("a schema-1 upgrade without any user config file removes no machine key from the project config", async () => {
  const v1 = JSON.stringify({
    mod: { name: "ModA" },
    modsDir: "D:\\OtherMods",
    stubs: { classes: [], scriptClasses: [], modAssets: "all" },
  });
  const s = setup({ [win32.join(TARGET, "abf.config.json")]: v1, [win32.join(TARGET, "src", "A.ts")]: "export {};\n" });
  s.fake.files[win32.join("D:\\OtherMods", "ModA", "ModA.uplugin")] = "{}";
  delete s.fake.env.ABFC_USER_CONFIG;
  delete s.fake.env.APPDATA;
  await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  const cfg = JSON.parse(read(s, "abf.config.json")) as { schemaVersion: number; modsDir?: string };
  assert.equal(cfg.schemaVersion, 2);
  assert.equal(cfg.modsDir, "D:\\OtherMods");
  assert.doesNotMatch(s.cap.text(), /moved/);
});

test("--yes on a schema-1 project finds the Mod Editor and mods folder from its own machine keys", async () => {
  const exeRel = loadProfile().exeRelPath;
  const v1 = JSON.stringify({
    mod: { name: "ModA" },
    editor: { root: "C:\\Epic\\OtherEdit" },
    modsDir: "D:\\OtherMods",
    stubs: { classes: [], scriptClasses: [], modAssets: "all" },
  });
  const modsRoot = win32.dirname(setup().fake.modDir).replace(/[\\.]/g, "\\$&");
  const s = setup(
    {
      [win32.join(TARGET, "abf.config.json")]: v1,
      [win32.join("C:\\Epic\\OtherEdit", exeRel)]: "exe",
      [win32.join("D:\\OtherMods", "ModA", "ModA.uplugin")]: "{}",
    },
    new RegExp(`ModEdit_X1\\\\.*\\.exe$|^${modsRoot}\\\\`, "i"),
  );
  const code = await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps);
  assert.doesNotMatch(s.cap.text(), /ABFC1001|ABFC1003/);
  assert.equal(code, 0, s.cap.text());
  const user = JSON.parse(s.fake.files[USER_CONFIG] as string) as { editor: { root: string }; modsDir: string };
  assert.equal(user.editor.root, "C:\\Epic\\OtherEdit");
  assert.equal(user.modsDir, "D:\\OtherMods");
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

test("init --no-stubs writes .abfc/tags.d.ts with the mod's ini tags; an existing file is kept", async () => {
  const modsDir = win32.dirname(setup().fake.modDir);
  const ini = '[/Script/GameplayTags.GameplayTagsSettings]\r\n+GameplayTagList=(Tag="Mod.Own.Tag",DevComment="")\r\n';
  const s = setup({ [win32.join(modsDir, "ModA", "Config", "Tags", "ExampleTags.ini")]: ini });
  assert.equal(await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  assert.match(read(s, ".abfc", "tags.d.ts"), /"Mod\.Own\.Tag": true/);
  assert.match(read(s, ".abfc", "tags.d.ts"), /declare const Mod\b/);
  assert.match(s.cap.text(), /written\s+\.abfc\/tags\.d\.ts/);
  // a second run keeps what `abfc stubs` / `abfc build` may have extended
  const again = setup({
    [win32.join(modsDir, "ModA", "Config", "Tags", "ExampleTags.ini")]: ini,
    [win32.join(TARGET, ".abfc", "tags.d.ts")]: "// game tags too\n",
  });
  assert.equal(await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], again.cap.deps), 0, again.cap.text());
  assert.equal(read(again, ".abfc", "tags.d.ts"), "// game tags too\n");
  assert.match(again.cap.text(), /kept\s+\.abfc\/tags\.d\.ts/);
});

test("init warns ABFC1043 when the kept tsconfig.json has its own files (it replaces the inherited .abfc/tags.d.ts)", async () => {
  const s = setup({
    [win32.join(TARGET, "tsconfig.json")]: JSON.stringify({ extends: "./.abfc/tsconfig.paths.json", files: ["src/main.ts"] }),
  });
  assert.equal(await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  assert.match(s.cap.text(), /warning ABFC1043: tsconfig\.json has its own "files"/);
  const plain = setup({ [win32.join(TARGET, "tsconfig.json")]: JSON.stringify({ extends: "./.abfc/tsconfig.paths.json" }) });
  assert.equal(await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], plain.cap.deps), 0, plain.cap.text());
  assert.doesNotMatch(plain.cap.text(), /has its own "files"/);
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

// ---------------------------------------------------------------- interactive prompt

interface Asked {
  questions: string[];
  left: () => number;
}

/** Makes `s` interactive; the prompt answers from `answers` in order and records the questions. */
function interactive(s: Setup, answers: string[]): Asked {
  const questions: string[] = [];
  const queue = [...answers];
  s.cap.deps.interactive = true;
  s.cap.deps.prompt = async (q) => {
    questions.push(q);
    const a = queue.shift();
    if (a === undefined) throw new Error(`no scripted answer for: ${q}`);
    return a;
  };
  return { questions, left: () => queue.length };
}

const userConfigOf = (s: Setup): Record<string, unknown> => JSON.parse(s.fake.files[USER_CONFIG] as string) as Record<string, unknown>;
const modOf = (s: Setup): string => (JSON.parse(read(s, "abf.config.json")) as { mod: { name: string } }).mod.name;

test("interactive: the mod is picked by number, the screen lists the mods, then y writes", async () => {
  const s = setup();
  const asked = interactive(s, ["2", "y"]);
  const code = await main(["init", TARGET, "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  const out = s.cap.text();
  assert.match(out, /Mod Editor: C:\\Epic\\ModEdit_X1\s+\(Epic manifest\)/);
  assert.match(out, /Mods folder: .*\(auto\)/);
  assert.match(out, /1\) ModA\s+"Mod A"\s+1 assets/);
  assert.match(out, /2\) ModB/);
  assert.match(out, /c\) change the mods folder and rescan/);
  assert.match(out, /q\) quit without writing anything/);
  assert.doesNotMatch(out, /NotAMod/);
  assert.deepEqual(asked.questions, ["Link which mod? [1-2, c, q]: ", "Write these files? [y/N]: "]);
  assert.equal(asked.left(), 0);
  assert.equal(modOf(s), "ModB");
  assert.ok(s.cap.writes.includes(USER_CONFIG));
});

test("interactive: garbage is re-asked, 'yes' also confirms", async () => {
  const s = setup();
  const asked = interactive(s, ["", "7", "x", "0", "1", "yes"]);
  const code = await main(["init", TARGET, "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  assert.equal(asked.questions.filter((q) => q.startsWith("Link which mod?")).length, 5);
  assert.match(s.cap.text(), /please answer 1-2, c or q/);
  assert.equal(modOf(s), "ModA");
});

test("interactive: c asks for another mods folder (re-asked until it exists), rescans and a mod there can be picked", async () => {
  const other = "D:\\MoreMods";
  const s = setup({ [win32.join(other, "ModC", "ModC.uplugin")]: JSON.stringify({ FriendlyName: "Mod C" }) });
  const asked = interactive(s, ["c", "D:\\Missing", `"${other}"`, "1", "y"]);
  const code = await main(["init", TARGET, "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  const out = s.cap.text();
  assert.match(out, /D:\\Missing does not exist/);
  assert.match(out, /Mods folder: D:\\MoreMods\s+\(entered\)/);
  assert.match(out, /1\) ModC\s+"Mod C"/);
  assert.deepEqual(asked.questions, [
    "Link which mod? [1-2, c, q]: ",
    "Mods folder (q to quit): ",
    "Mods folder (q to quit): ",
    "Link which mod? [1, c, q]: ",
    "Write these files? [y/N]: ",
  ]);
  assert.equal(modOf(s), "ModC");
  assert.equal(userConfigOf(s).modsDir, other, "the chosen mods folder goes into the user config");
});

test("interactive: q writes nothing and exits 0", async () => {
  const s = setup();
  const asked = interactive(s, ["q"]);
  const code = await main(["init", TARGET, "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  assert.deepEqual(s.cap.writes, []);
  assert.match(s.cap.text(), /Nothing written\./);
  assert.equal(asked.questions.length, 1);
});

test("interactive: anything but y or yes to the final question writes nothing", async () => {
  for (const answer of ["n", "", "maybe"]) {
    const s = setup();
    interactive(s, ["1", answer]);
    const code = await main(["init", TARGET, "--no-stubs"], s.cap.deps);
    assert.equal(code, 0, s.cap.text());
    assert.deepEqual(s.cap.writes, [], `answer "${answer}"`);
    assert.match(s.cap.text(), /Nothing written\./);
    assert.match(s.cap.text(), /written\s+abf\.config\.json/, "the summary was shown before the question");
  }
});

test("interactive: --mod X preselects the mod and asks only the final question", async () => {
  const s = setup();
  const asked = interactive(s, ["y"]);
  const code = await main(["init", TARGET, "--mod", "modb", "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  assert.deepEqual(asked.questions, ["Write these files? [y/N]: "]);
  assert.equal(modOf(s), "ModB");
});

test("interactive: --mod with an unknown mod is ABFC1042 before any question", async () => {
  const s = setup();
  const asked = interactive(s, []);
  const code = await main(["init", TARGET, "--mod", "Nope", "--no-stubs"], s.cap.deps);
  assert.equal(code, 1, s.cap.text());
  assert.match(s.cap.text(), /error ABFC1042/);
  assert.equal(asked.questions.length, 0);
  assert.deepEqual(s.cap.writes, []);
});

test("interactive: an empty mods folder prints ABFC1044 and offers only c and q", async () => {
  const s = setup({}, /\\(ModA|ModB)\\/);
  const asked = interactive(s, ["1", "q"]);
  const code = await main(["init", TARGET, "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  assert.match(s.cap.text(), /ABFC1044: no mods found in/);
  assert.deepEqual(asked.questions, ["Link which mod? [c, q]: ", "Link which mod? [c, q]: "]);
  assert.deepEqual(s.cap.writes, []);
});

test("interactive: a missing Mod Editor is asked for, validated, re-asked and goes into the user config", async () => {
  const exeRel = loadProfile().exeRelPath;
  const s = setup({ [win32.join("C:\\Epic\\OtherEdit", exeRel)]: "exe" }, /ModEdit_X1\\.*\.exe$/i);
  const asked = interactive(s, ["C:\\Epic\\Nowhere", "C:\\Epic\\OtherEdit", "1", "y"]);
  await main(["init", TARGET, "--no-stubs"], s.cap.deps);
  const out = s.cap.text();
  assert.match(out, /ABFC1001/);
  assert.match(out, /\.exe in C:\\Epic\\Nowhere/);
  assert.match(out, /Mod Editor: C:\\Epic\\OtherEdit\s+\(entered\)/);
  assert.equal(asked.questions[0], "Mod Editor folder (q to quit): ");
  assert.equal(asked.questions[1], "Mod Editor folder (q to quit): ");
  assert.equal(asked.left(), 0);
  assert.deepEqual((userConfigOf(s).editor as { root: string }).root, "C:\\Epic\\OtherEdit");
  assert.equal(modOf(s), "ModA");
});

test("interactive: a missing mods folder is asked for (ABFC1003 is not fatal)", async () => {
  const modsRoot = win32.dirname(setup().fake.modDir).replace(/[\\.]/g, "\\$&");
  const s = setup({ "D:\\MoreMods\\ModC\\ModC.uplugin": "{}" }, new RegExp(`^${modsRoot}\\\\`, "i"));
  const asked = interactive(s, ["D:\\Nope", "D:\\MoreMods", "1", "y"]);
  await main(["init", TARGET, "--no-stubs"], s.cap.deps);
  const out = s.cap.text();
  assert.match(out, /ABFC1003/);
  assert.match(out, /D:\\Nope does not exist/);
  assert.equal(asked.questions[0], "Mods folder (q to quit): ");
  assert.equal(asked.left(), 0);
  assert.equal(modOf(s), "ModC");
});

test("interactive: a re-run with nothing to change says so and asks no final question", async () => {
  const s = setup();
  assert.equal(await main(["init", TARGET, "--mod", "ModA", "--yes", "--no-stubs"], s.cap.deps), 0, s.cap.text());
  s.cap.writes.length = 0;
  const asked = interactive(s, []);
  const code = await main(["init", TARGET, "--mod", "ModA", "--no-stubs"], s.cap.deps);
  assert.equal(code, 0, s.cap.text());
  assert.match(s.cap.text(), /Nothing to write\./);
  assert.deepEqual(asked.questions, []);
  assert.deepEqual(s.cap.writes, []);
});
