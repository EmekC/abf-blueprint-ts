import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AbfcError,
  MOD_SCAN_ASSET_CAP,
  loadProfile,
  loadProjectConfig,
  migrateProjectConfigText,
  scanMods,
  updateUserConfigText,
} from "../src/index.js";
import { fakeHost } from "./fakehost.js";

const mods = "D:\\Mods";

function errorCode(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (e) {
    if (e instanceof AbfcError) return { code: e.diagnostic.code, message: e.diagnostic.message };
    throw e;
  }
  assert.fail("expected an AbfcError");
}

// ---------------------------------------------------------------- scanMods

test("scanMods: matching folders only, FriendlyName, asset counts, sorted case-insensitively", () => {
  const host = fakeHost({
    files: {
      [`${mods}\\beta\\beta.uplugin`]: "\uFEFF" + JSON.stringify({ FriendlyName: "Beta Mod" }),
      [`${mods}\\beta\\Content\\A\\x.uasset`]: "",
      [`${mods}\\beta\\Content\\A\\y.UASSET`]: "",
      [`${mods}\\beta\\Content\\z.uexp`]: "",
      [`${mods}\\Alpha\\ALPHA.UPLUGIN`]: "{ not json",
      [`${mods}\\Alpha\\Content\\q.uasset`]: "",
      [`${mods}\\NoPlugin\\Content\\q.uasset`]: "",
      [`${mods}\\Wrong\\Other.uplugin`]: "{}",
      [`${mods}\\stray.txt`]: "",
    },
  });
  const found = scanMods(host, mods);
  assert.deepEqual(
    found.map((m) => [m.name, m.friendlyName, m.assetCount, m.assetCountCapped]),
    [
      ["Alpha", null, 1, false],
      ["beta", "Beta Mod", 2, false],
    ],
  );
  assert.equal(found[0]?.dir, `${mods}\\Alpha`);
});

test("scanMods: a mod without Content has no assets; an empty folder has no mods", () => {
  const host = fakeHost({ files: { [`${mods}\\Solo\\Solo.uplugin`]: "{}" }, dirs: [`${mods}\\Empty`] });
  assert.deepEqual(
    scanMods(host, mods).map((m) => [m.name, m.friendlyName, m.assetCount]),
    [["Solo", null, 0]],
  );
  assert.deepEqual(scanMods(fakeHost({ dirs: ["D:\\Nothing"] }), "D:\\Nothing"), []);
});

test("scanMods: the asset walk is capped", () => {
  const files: Record<string, string> = { [`${mods}\\Big\\Big.uplugin`]: "{}" };
  for (let i = 0; i < MOD_SCAN_ASSET_CAP + 1; i++) files[`${mods}\\Big\\Content\\a${i}.uasset`] = "";
  files[`${mods}\\Exact\\Exact.uplugin`] = "{}";
  for (let i = 0; i < MOD_SCAN_ASSET_CAP; i++) files[`${mods}\\Exact\\Content\\a${i}.uasset`] = "";
  const found = scanMods(fakeHost({ files }), mods);
  assert.deepEqual(
    found.map((m) => [m.name, m.assetCount, m.assetCountCapped]),
    [
      ["Big", MOD_SCAN_ASSET_CAP, true],
      ["Exact", MOD_SCAN_ASSET_CAP, false],
    ],
  );
});

// ---------------------------------------------------------------- updateUserConfigText

test("updateUserConfigText: a new file gets schemaVersion first and the patched keys", () => {
  const r = updateUserConfigText(null, { editorRoot: "C:\\Editor", modsDir: "D:\\Mods" });
  assert.deepEqual(r.changedKeys, ["schemaVersion", "editor.root", "modsDir"]);
  assert.equal(
    r.text,
    '{\n  "schemaVersion": 2,\n  "editor": {\n    "root": "C:\\\\Editor"\n  },\n  "modsDir": "D:\\\\Mods"\n}\n',
  );
});

test("updateUserConfigText: merges, keeps other keys and their order, BOM tolerated", () => {
  const existing = "\uFEFF" + JSON.stringify({ headlessDir: "C:\\h", editor: { root: "C:\\Old", extra: 1 }, other: [1] });
  const r = updateUserConfigText(existing, { editorRoot: "C:\\New", backendDir: "D:\\be", python: "C:\\py\\python.exe" });
  assert.deepEqual(r.changedKeys, ["schemaVersion", "editor.root", "backend.serverDir", "backend.python"]);
  const parsed = JSON.parse(r.text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["schemaVersion", "headlessDir", "editor", "other", "backend"]);
  assert.deepEqual(parsed.editor, { root: "C:\\New", extra: 1 });
  assert.deepEqual(parsed.backend, { serverDir: "D:\\be", python: "C:\\py\\python.exe" });
  assert.ok(r.text.endsWith("}\n"));
});

test("updateUserConfigText: nothing to change returns the existing text", () => {
  const existing = '{"schemaVersion":2,"modsDir":"D:\\\\Mods"}';
  const r = updateUserConfigText(existing, { modsDir: "D:\\Mods" });
  assert.deepEqual(r.changedKeys, []);
  assert.equal(r.text, existing);
  const again = updateUserConfigText(null, { modsDir: "D:\\Mods" });
  assert.deepEqual(updateUserConfigText(again.text, { modsDir: "D:\\Mods" }).changedKeys, []);
});

test("updateUserConfigText: invalid JSON is ABFC1021 and names the file", () => {
  const e = errorCode(() => updateUserConfigText("{ nope", { modsDir: "D:\\Mods" }, "C:\\cfg\\config.json"));
  assert.equal(e.code, "ABFC1021");
  assert.match(e.message, /C:\\cfg\\config\.json/);
  assert.equal(errorCode(() => updateUserConfigText("[1]", {})).code, "ABFC1021");
});

// ---------------------------------------------------------------- migrateProjectConfigText

const schema1 = {
  mod: { name: "TestMod", dir: "D:\\Mods\\TestMod" },
  stubs: { classes: ["/Script/Engine.Actor"], modAssets: ["/TestMod/Relays/BP_X", "/testmod/Y", "Z", "/OtherMod/W"] },
  backend: { kind: "bp_apply", minProtocol: 1, serverDir: "D:\\be", python: "C:\\py\\python.exe" },
  editor: { root: "C:\\Editor" },
  modsDir: "D:\\Mods",
  headlessDir: "C:\\h",
};

test("migrateProjectConfigText: schema 1 with machine keys", () => {
  const r = migrateProjectConfigText(JSON.stringify(schema1));
  assert.deepEqual(r.machineKeys, {
    "editor.root": "C:\\Editor",
    modsDir: "D:\\Mods",
    headlessDir: "C:\\h",
    "mod.dir": "D:\\Mods\\TestMod",
    "backend.serverDir": "D:\\be",
    "backend.python": "C:\\py\\python.exe",
  });
  assert.deepEqual(r.droppedModAssets, ["/OtherMod/W"]);
  const parsed = JSON.parse(r.text) as Record<string, unknown>;
  assert.equal(Object.keys(parsed)[0], "schemaVersion");
  assert.deepEqual(parsed, {
    schemaVersion: 2,
    mod: { name: "TestMod" },
    stubs: { classes: ["/Script/Engine.Actor"], modAssets: ["Relays/BP_X", "Y", "Z"] },
    backend: { kind: "bp_apply", minProtocol: 1 },
  });
  assert.ok(r.text.endsWith("}\n"));
  // The result loads as a schema 2 project config.
  const cfg = loadProjectConfig("D:\\p", fakeHost({ files: { "D:\\p\\abf.config.json": r.text } }));
  assert.equal(cfg.schemaVersion, 2);
  assert.deepEqual(cfg.stubs.modAssets, ["/TestMod/Relays/BP_X", "/TestMod/Y", "/TestMod/Z"]);
});

test("migrateProjectConfigText: schema 1 with `all` and no machine keys", () => {
  const r = migrateProjectConfigText('{ "schemaVersion": 1, "mod": { "name": "TestMod" }, "stubs": { "modAssets": "all" } }');
  assert.deepEqual(r.machineKeys, {});
  assert.deepEqual(JSON.parse(r.text), { schemaVersion: 2, mod: { name: "TestMod" }, stubs: { modAssets: "all" } });
});

test("migrateProjectConfigText: schema 2 is returned unchanged", () => {
  const text = '{"schemaVersion":2,"mod":{"name":"TestMod"},"modsDir":"D:\\\\Mods"}';
  const r = migrateProjectConfigText(text);
  assert.equal(r.text, text);
  assert.deepEqual(r.machineKeys, {});
});

test("migrateProjectConfigText: invalid JSON is ABFC1021", () => {
  assert.equal(errorCode(() => migrateProjectConfigText("{")).code, "ABFC1021");
  assert.equal(errorCode(() => migrateProjectConfigText("3")).code, "ABFC1021");
});

// ---------------------------------------------------------------- profile

test("the profile lists the engine classes init puts into a new project", () => {
  const p = loadProfile();
  assert.equal(p.initScriptClasses.length, 15);
  assert.ok(p.initScriptClasses.every((c) => c.startsWith("/Script/")));
  assert.ok(p.initScriptClasses.includes("/Script/Engine.Actor"));
  assert.ok(p.initScriptClasses.includes("/Script/UMG.PanelSlot"));
});
