import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignature } from "../src/signature.js";
import type { TypeCtx } from "../src/typemap.js";

// buildSignature only needs the type context for object/struct grammars; primitives never touch it
const ctx = {} as TypeCtx;

test("the trailing run of pins with a C++ default is optional and carries @bpDefault", () => {
  const sig = buildSignature(
    [
      { pin: "InString", grammar: "string", default: "Hello" },
      { pin: "bPrintToScreen", grammar: "bool", default: "true" },
    ],
    [],
    [],
    ctx,
  );
  assert.equal(sig.params, "InString?: string, bPrintToScreen?: boolean");
  assert.ok(sig.tags.includes('@bpDefault InString "Hello"'));
  assert.ok(sig.tags.includes('@bpDefault bPrintToScreen "true"'));
});

test("a default only on a middle parameter keeps it required; no defaults leave the signature unchanged", () => {
  const mid = buildSignature(
    [
      { pin: "A", grammar: "bool" },
      { pin: "B", grammar: "bool", default: "1" },
      { pin: "C", grammar: "bool" },
    ],
    [],
    [],
    ctx,
  );
  assert.equal(mid.params, "A: boolean, B: boolean, C: boolean");
  assert.ok(!mid.tags.some((t) => t.startsWith("@bpDefault")));
  const none = buildSignature([{ pin: "A", grammar: "bool" }], [], [], ctx);
  assert.equal(none.params, "A: boolean");
});
