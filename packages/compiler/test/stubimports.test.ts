import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { sourceStubImports, stubImportAt } from "../src/index.js";

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "abfc-stubimports-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function put(dir: string, rel: string, text: string): void {
  const file = join(dir, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

test("sourceStubImports collects /Script and /Game imports and re-exports with their exported names", () => {
  withDir((dir) => {
    put(
      dir,
      "src/a.ts",
      [
        `import { Actor as A, Pawn } from "/Script/FakeEngine";`,
        `import type { FakeVec } from "/Script/FakeEngine";`,
        `import { BP_Fake_C } from "/Game/Fake/BP_Fake";`,
        `import Def from "/Game/Fake/Other";`,
        `import * as NS from "/Script/FakeOther";`,
        `import { x } from "./local";`,
        `import "/Script/SideEffect";`,
        `export { Thing } from "/Script/FakeEngine";`,
        `export * from "/Game/Fake/All";`,
        `export { y };`,
        ``,
      ].join("\n"),
    );
    put(dir, "src/deep/b.tsx", `import { Widget } from "/Script/FakeUmg";\n`);
    put(dir, "src/types.d.ts", `import { Skipped } from "/Script/FakeEngine";\n`);
    put(dir, "src/node_modules/m.ts", `import { Skipped } from "/Script/FakeEngine";\n`);
    put(dir, "src/.hidden/h.ts", `import { Skipped } from "/Script/FakeEngine";\n`);
    put(dir, "src/readme.md", `import { Skipped } from "/Script/FakeEngine";\n`);

    const got = sourceStubImports(dir, "src").map((i) => ({ specifier: i.specifier, names: i.names, file: i.file.slice(dir.length + 1).replaceAll("\\", "/") }));
    assert.deepEqual(got, [
      { specifier: "/Script/FakeEngine", names: ["Actor", "Pawn"], file: "src/a.ts" },
      { specifier: "/Script/FakeEngine", names: ["FakeVec"], file: "src/a.ts" },
      { specifier: "/Game/Fake/BP_Fake", names: ["BP_Fake_C"], file: "src/a.ts" },
      { specifier: "/Game/Fake/Other", names: [], file: "src/a.ts" },
      { specifier: "/Script/FakeOther", names: [], file: "src/a.ts" },
      { specifier: "/Script/SideEffect", names: [], file: "src/a.ts" },
      { specifier: "/Script/FakeEngine", names: ["Thing"], file: "src/a.ts" },
      { specifier: "/Game/Fake/All", names: [], file: "src/a.ts" },
      { specifier: "/Script/FakeUmg", names: ["Widget"], file: "src/deep/b.tsx" },
    ]);
  });
});

test("sourceStubImports: a missing source root gives nothing", () => {
  withDir((dir) => {
    assert.deepEqual(sourceStubImports(dir, "src"), []);
  });
});

const SRC = [
  `import { Actor as A, Pawn } from "/Script/FakeEngine";`,
  `import type { FakeVec } from "/Script/FakeEngine";`,
  `import { x } from "./local";`,
  `export { Thing } from "/Game/Fake/BP_Fake";`,
  ``,
].join("\n");

function parse(): ts.SourceFile {
  return ts.createSourceFile("a.ts", SRC, ts.ScriptTarget.Latest, true);
}

const rangeOf = (needle: string): [number, number] => {
  const i = SRC.indexOf(needle);
  assert.ok(i >= 0, needle);
  return [i, i + needle.length];
};

test("stubImportAt: a range on one element gives that element's exported name", () => {
  const sf = parse();
  assert.deepEqual(stubImportAt(sf, ...rangeOf("Actor as A")), { specifier: "/Script/FakeEngine", names: ["Actor"] });
  assert.deepEqual(stubImportAt(sf, ...rangeOf("Pawn")), { specifier: "/Script/FakeEngine", names: ["Pawn"] });
  assert.deepEqual(stubImportAt(sf, ...rangeOf("FakeVec")), { specifier: "/Script/FakeEngine", names: ["FakeVec"] });
});

test("stubImportAt: a range on the specifier gives every named element", () => {
  const sf = parse();
  assert.deepEqual(stubImportAt(sf, ...rangeOf(`"/Script/FakeEngine"`)), { specifier: "/Script/FakeEngine", names: ["Actor", "Pawn"] });
  assert.deepEqual(stubImportAt(sf, ...rangeOf(`"/Game/Fake/BP_Fake"`)), { specifier: "/Game/Fake/BP_Fake", names: ["Thing"] });
});

test("stubImportAt: a range over two elements gives both; re-exports work", () => {
  const sf = parse();
  assert.deepEqual(stubImportAt(sf, ...rangeOf("Actor as A, Pawn")), { specifier: "/Script/FakeEngine", names: ["Actor", "Pawn"] });
  assert.deepEqual(stubImportAt(sf, ...rangeOf("Thing")), { specifier: "/Game/Fake/BP_Fake", names: ["Thing"] });
});

test("stubImportAt: other modules and ranges outside any declaration give undefined", () => {
  const sf = parse();
  assert.equal(stubImportAt(sf, ...rangeOf(`"./local"`)), undefined);
  assert.equal(stubImportAt(sf, ...rangeOf(`x`)), undefined);
  assert.equal(stubImportAt(sf, SRC.length, SRC.length), undefined);
});
