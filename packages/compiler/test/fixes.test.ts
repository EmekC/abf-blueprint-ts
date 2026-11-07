import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { directorFix, idivFix, keepPathFix, modImportFix, optionalChainFix, relativePathFix, removePathFix } from "../src/index.js";
import type { TextEdit } from "../src/index.js";

const sf = (text: string): ts.SourceFile => ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2023, true);

function apply(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.start + e.length);
  return out;
}

/** The [start, end) of the first occurrence of `needle`. */
const range = (text: string, needle: string): [number, number] => {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `${needle} in sample`);
  return [i, i + needle.length];
};

test("idivFix replaces the division and adds the import at the top", () => {
  const text = `export class A {\n  M(): void {\n    this.Count = this.Total / 2;\n  }\n}\n`;
  const [s, e] = range(text, "this.Total / 2");
  const edits = idivFix(sf(text), s, e);
  assert.ok(edits);
  assert.equal(
    apply(text, edits),
    `import { idiv } from "@abfc/runtime";\nexport class A {\n  M(): void {\n    this.Count = idiv(this.Total, 2);\n  }\n}\n`,
  );
});

test("idivFix appends to an existing @abfc/runtime import and picks the innermost division", () => {
  const text = `import { blueprint, event } from "@abfc/runtime";\nconst x = (a / b) / c;\n`;
  const [s, e] = range(text, "a / b");
  const edits = idivFix(sf(text), s, e);
  assert.ok(edits);
  assert.equal(apply(text, edits), `import { blueprint, event, idiv } from "@abfc/runtime";\nconst x = (idiv(a, b)) / c;\n`);
});

test("idivFix does not import idiv twice and ignores a type-only import", () => {
  const withIdiv = `import { idiv } from "@abfc/runtime";\nconst x = a / b;\n`;
  const [s, e] = range(withIdiv, "a / b");
  const first = idivFix(sf(withIdiv), s, e);
  assert.ok(first);
  assert.equal(apply(withIdiv, first), `import { idiv } from "@abfc/runtime";\nconst x = idiv(a, b);\n`);

  const typeOnly = `import type { int } from "@abfc/runtime";\nconst x = a / b;\n`;
  const [s2, e2] = range(typeOnly, "a / b");
  const second = idivFix(sf(typeOnly), s2, e2);
  assert.ok(second);
  assert.equal(apply(typeOnly, second), `import { idiv } from "@abfc/runtime";\nimport type { int } from "@abfc/runtime";\nconst x = idiv(a, b);\n`);
});

test("idivFix uses an aliased idiv import and adds a named one next to a type-only alias", () => {
  const aliased = `import { idiv as div } from "@abfc/runtime";\nconst x = a / b;\n`;
  const [s, e] = range(aliased, "a / b");
  const first = idivFix(sf(aliased), s, e);
  assert.ok(first);
  assert.equal(first.length, 1, "no import edit");
  assert.equal(apply(aliased, first), `import { idiv as div } from "@abfc/runtime";\nconst x = div(a, b);\n`);

  const typeOnlyAlias = `import { type idiv as div } from "@abfc/runtime";\nconst x = a / b;\n`;
  const [s2, e2] = range(typeOnlyAlias, "a / b");
  const second = idivFix(sf(typeOnlyAlias), s2, e2);
  assert.ok(second);
  assert.equal(apply(typeOnlyAlias, second), `import { type idiv as div, idiv } from "@abfc/runtime";\nconst x = idiv(a, b);\n`);

  const typeOnlyClause = `import type { idiv as div } from "@abfc/runtime";\nconst x = a / b;\n`;
  const [s3, e3] = range(typeOnlyClause, "a / b");
  const third = idivFix(sf(typeOnlyClause), s3, e3);
  assert.ok(third);
  assert.equal(apply(typeOnlyClause, third), `import { idiv } from "@abfc/runtime";\nimport type { idiv as div } from "@abfc/runtime";\nconst x = idiv(a, b);\n`);
});

test("idivFix finds no division where there is none", () => {
  const text = `const x = a + b;\n`;
  const [s, e] = range(text, "a + b");
  assert.equal(idivFix(sf(text), s, e), undefined);
});

test("optionalChainFix makes a property access optional", () => {
  const text = `function f(a: { b: number } | undefined) {\n  return a.b;\n}\n`;
  const [s, e] = range(text, "a.b");
  const edits = optionalChainFix(sf(text), s, s + 1);
  assert.ok(edits);
  assert.equal(e - s, 3);
  assert.equal(apply(text, edits), `function f(a: { b: number } | undefined) {\n  return a?.b;\n}\n`);
});

test("optionalChainFix handles element access, a chain and a dot on the next line", () => {
  const el = `const v = arr[0];\n`;
  const [s, e] = range(el, "arr");
  const a = optionalChainFix(sf(el), s, e);
  assert.ok(a);
  assert.equal(apply(el, a), `const v = arr?.[0];\n`);

  const chain = `const v = a.b.c;\n`;
  const [s2, e2] = range(chain, "a.b");
  const b = optionalChainFix(sf(chain), s2, e2);
  assert.ok(b);
  assert.equal(apply(chain, b), `const v = a.b?.c;\n`);

  const wrapped = `const v = a\n  .b;\n`;
  const [s3, e3] = range(wrapped, "a");
  const c = optionalChainFix(sf(wrapped), s3, s3 + 1);
  assert.ok(c);
  assert.equal(e3 - s3, 1);
  assert.equal(apply(wrapped, c), `const v = a\n  ?.b;\n`);
});

test("optionalChainFix refuses an already optional access and a span that is not an access target", () => {
  const text = `const v = a?.b;\n`;
  const [s, e] = range(text, "a");
  assert.equal(optionalChainFix(sf(text), s, e), undefined);
  const call = `f(a);\n`;
  const [s2, e2] = range(call, "a");
  assert.equal(optionalChainFix(sf(call), s2, e2), undefined);
});

test("optionalChainFix offers nothing on assignment targets", () => {
  const writes: Array<[string, string]> = [
    [`a.b = 1;\n`, "a"],
    [`a.b += 1;\n`, "a"],
    [`a.b++;\n`, "a"],
    [`--a.b;\n`, "a"],
    [`a.b.c = 1;\n`, "a"],
    [`a.b.c = 1;\n`, "a.b"],
    [`[a.b] = xs;\n`, "a"],
    [`({ k: a.b } = o);\n`, "a"],
    [`for (a.b of xs) {}\n`, "a"],
  ];
  for (const [text, needle] of writes) {
    const [s, e] = range(text, needle);
    assert.equal(optionalChainFix(sf(text), s, e), undefined, text);
  }
});

test("optionalChainFix still fixes reads next to assignments", () => {
  const reads: Array<[string, string, string]> = [
    [`x = a.b;\n`, "a", `x = a?.b;\n`],
    [`f(a.b);\n`, "a", `f(a?.b);\n`],
    [`a.b();\n`, "a", `a?.b();\n`],
    [`const v = [a.b];\n`, "a", `const v = [a?.b];\n`],
    [`const v = a.b === 1;\n`, "a", `const v = a?.b === 1;\n`],
  ];
  for (const [text, needle, expected] of reads) {
    const [s, e] = range(text, needle);
    const edits = optionalChainFix(sf(text), s, e);
    assert.ok(edits, text);
    assert.equal(apply(text, edits), expected);
  }
});

test("removePathFix: the only option takes the whole object, otherwise the property and one comma", () => {
  const cases: Array<[string, string, string]> = [
    [`@blueprint({ path: "X" })\nclass A {}\n`, `path: "X"`, `@blueprint()\nclass A {}\n`],
    [`@struct({ path: "X" })\nclass A {}\n`, `path: "X"`, `@struct()\nclass A {}\n`],
    [`@blueprint({ path: "X", replicates: true })\nclass A {}\n`, `path: "X"`, `@blueprint({ replicates: true })\nclass A {}\n`],
    [`@blueprint({ replicates: true, path: "X" })\nclass A {}\n`, `path: "X"`, `@blueprint({ replicates: true })\nclass A {}\n`],
    [`@blueprint({ replicates: true, path: "X", kind: "widget" })\nclass A {}\n`, `path: "X"`, `@blueprint({ replicates: true, kind: "widget" })\nclass A {}\n`],
    [`@blueprint({\n  path: "X",\n  replicates: true,\n})\nclass A {}\n`, `path: "X"`, `@blueprint({\n  replicates: true,\n})\nclass A {}\n`],
  ];
  for (const [text, needle, expected] of cases) {
    const [s, e] = range(text, needle);
    const edits = removePathFix(sf(text), s, e);
    assert.ok(edits, text);
    assert.equal(apply(text, edits), expected);
  }
});

test("removePathFix is undefined outside a path option of @blueprint/@struct", () => {
  const text = `@blueprint({ replicates: true })\nclass A {}\nconst o = { path: "X" };\n`;
  assert.equal(removePathFix(sf(text), ...range(text, "replicates: true")), undefined);
  assert.equal(removePathFix(sf(text), ...range(text, `path: "X"`)), undefined);
});

test("relativePathFix rewrites the absolute path relative to the mod, keeping the quote character", () => {
  const dq = `@blueprint({ path: "/TestMod/Relays/MyRelay" })\nclass A {}\n`;
  assert.equal(apply(dq, relativePathFix(sf(dq), ...range(dq, `path: "/TestMod/Relays/MyRelay"`), "TestMod")!), `@blueprint({ path: "Relays/MyRelay" })\nclass A {}\n`);
  const sq = `@struct({ path: '/testmod/S_X' })\nclass S {}\n`;
  assert.equal(apply(sq, relativePathFix(sf(sq), ...range(sq, "path: '/testmod/S_X'"), "TestMod")!), `@struct({ path: 'S_X' })\nclass S {}\n`);
});

test("relativePathFix is undefined for a relative path or another mod", () => {
  const rel = `@blueprint({ path: "Relays/MyRelay" })\nclass A {}\n`;
  assert.equal(relativePathFix(sf(rel), ...range(rel, `path: "Relays/MyRelay"`), "TestMod"), undefined);
  const other = `@blueprint({ path: "/OtherMod/X" })\nclass A {}\n`;
  assert.equal(relativePathFix(sf(other), ...range(other, `path: "/OtherMod/X"`), "TestMod"), undefined);
});

test("modImportFix rewrites the module specifier to @mod/", () => {
  const text = `import type { BP_Hand_Manual } from "/TestMod/Relays/BP_Hand";\n`;
  assert.equal(
    apply(text, modImportFix(sf(text), ...range(text, `"/TestMod/Relays/BP_Hand"`), "TestMod")!),
    `import type { BP_Hand_Manual } from "@mod/Relays/BP_Hand";\n`,
  );
});

test("modImportFix is undefined for other specifiers", () => {
  const text = `import { a } from "@mod/Relays/BP_Hand";\nimport { b } from "/Script/Engine";\n`;
  assert.equal(modImportFix(sf(text), ...range(text, `"@mod/Relays/BP_Hand"`), "TestMod"), undefined);
  assert.equal(modImportFix(sf(text), ...range(text, `"/Script/Engine"`), "TestMod"), undefined);
});

test("directorFix moves classManagerRow to @director above @blueprint and extends the runtime import", () => {
  const text = `import { blueprint } from "@abfc/runtime";\n\n@blueprint({ classManagerRow: "/TestMod/DataTables/DT_ClassManager/EntityDirector_X" })\nexport class BPC_X {}\n`;
  const [s, e] = range(text, `classManagerRow: "/TestMod/DataTables/DT_ClassManager/EntityDirector_X"`);
  const edits = directorFix(sf(text), s, e, "TestMod", "DataTables/DT_ClassManager");
  assert.ok(edits);
  assert.equal(
    apply(text, edits),
    `import { blueprint, director } from "@abfc/runtime";\n\n@director("EntityDirector_X")\n@blueprint()\nexport class BPC_X {}\n`,
  );
});

test("directorFix keeps other options and indentation, and adds the import when there is none", () => {
  const text = `class Host {\n  @blueprint({ replicates: true, classManagerRow: "/TestMod/T/Row_1" })\n  static C = 1;\n}\n`;
  // not a class declaration decorator: nothing to fix
  assert.equal(directorFix(sf(text), ...range(text, `classManagerRow: "/TestMod/T/Row_1"`), "TestMod", "T"), undefined);
  const cls = `@blueprint({ replicates: true, classManagerRow: "/TestMod/T/Row_1" })\nclass A {}\n`;
  const edits = directorFix(sf(cls), ...range(cls, `classManagerRow: "/TestMod/T/Row_1"`), "TestMod", "T");
  assert.ok(edits);
  assert.equal(apply(cls, edits), `import { director } from "@abfc/runtime";\n@director("Row_1")\n@blueprint({ replicates: true })\nclass A {}\n`);
});

test("directorFix is undefined when the row is not under /<mod>/<table>/", () => {
  const text = `@blueprint({ classManagerRow: "/TestMod/Other/Row_1" })\nclass A {}\n`;
  assert.equal(directorFix(sf(text), ...range(text, `classManagerRow: "/TestMod/Other/Row_1"`), "TestMod", "DataTables/DT_ClassManager"), undefined);
  const deep = `@blueprint({ classManagerRow: "/TestMod/T/Sub/Row_1" })\nclass A {}\n`;
  assert.equal(directorFix(sf(deep), ...range(deep, `classManagerRow: "/TestMod/T/Sub/Row_1"`), "TestMod", "T"), undefined);
});

test("keepPathFix adds path: as the first option (no arguments, empty object, existing options)", () => {
  const cases: Array<[string, string, string]> = [
    [`@blueprint()\nclass MyRelay {}\n`, "MyRelay", `@blueprint({ path: "Old/MyRelay" })\nclass MyRelay {}\n`],
    [`@blueprint({})\nclass MyRelay {}\n`, "MyRelay", `@blueprint({ path: "Old/MyRelay" })\nclass MyRelay {}\n`],
    [`@blueprint({ replicates: true })\nclass MyRelay {}\n`, "MyRelay", `@blueprint({ path: "Old/MyRelay", replicates: true })\nclass MyRelay {}\n`],
    [`@blueprint({\n  replicates: true,\n})\nclass MyRelay {}\n`, "MyRelay", `@blueprint({\n  path: "Old/MyRelay",\n  replicates: true,\n})\nclass MyRelay {}\n`],
    [`@struct()\nclass MyRelay {}\n`, "MyRelay", `@struct({ path: "Old/MyRelay" })\nclass MyRelay {}\n`],
  ];
  for (const [text, name, expected] of cases) {
    const at = text.indexOf(`class ${name}`) + "class ".length;
    const edits = keepPathFix(sf(text), at, "Old/MyRelay");
    assert.ok(edits, text);
    assert.equal(apply(text, edits), expected);
  }
});

test("keepPathFix is undefined for a class without the decorator, one with a path already, or an unknown offset", () => {
  const plain = `class MyRelay {}\n`;
  assert.equal(keepPathFix(sf(plain), plain.indexOf("MyRelay"), "Old/MyRelay"), undefined);
  const has = `@blueprint({ path: "A" })\nclass MyRelay {}\n`;
  assert.equal(keepPathFix(sf(has), has.indexOf("MyRelay"), "Old/MyRelay"), undefined);
  const ok = `@blueprint()\nclass MyRelay {}\n`;
  assert.equal(keepPathFix(sf(ok), 3, "Old/MyRelay"), undefined);
});
