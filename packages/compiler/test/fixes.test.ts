import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { idivFix, optionalChainFix } from "../src/index.js";
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
