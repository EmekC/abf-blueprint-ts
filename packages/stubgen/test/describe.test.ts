import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import { loadProfile } from "@abfc/env";
import { describeFunction, emitStubs, loadDescriptions, rulesFromPairs } from "../src/index.js";
import type { EmitInput, ReflectPin } from "../src/index.js";

const ACTOR = "/Script/Engine.Actor";

const pin = (name: string, dir: "in" | "out", category: string, extra: Partial<ReflectPin> = {}): ReflectPin => ({
  name,
  dir,
  category,
  subCategory: "",
  subCategoryObject: null,
  objectMeta: null,
  container: "None",
  hidden: false,
  default: null,
  ...extra,
});

function input(): EmitInput {
  const selfPin = pin("self", "in", "object", { subCategoryObject: ACTOR });
  const fn = (name: string): { name: string; pins: ReflectPin[] } => ({
    name,
    pins: [pin("execute", "in", "exec"), pin("then", "out", "exec"), selfPin],
  });
  return {
    profile: loadProfile(),
    reflect: {
      engineVersion: "5.4.4-fake",
      classes: {
        [ACTOR]: {
          meta: "/Script/CoreUObject.Class",
          ancestors: ["/Script/CoreUObject.Object"],
          castPin: "AsActor",
          properties: [],
          functions: [fn("K2_DestroyActor"), fn("FlushNetDormancyNow")],
        },
      },
      structs: {},
      enums: {},
      delegates: {},
      errors: [],
    } as unknown as EmitInput["reflect"],
    filter: { contentVersion: "v1", rules: rulesFromPairs([]) },
    manual: [],
    mod: "TestMod",
    opaque: [],
  };
}

test("displayed name rules and the curated table shape", () => {
  const table = loadDescriptions();
  assert.ok(Object.keys(table.functions).length >= 10);
  for (const [key, e] of Object.entries(table.functions)) {
    assert.match(key, /^\/[^:]+\.[A-Za-z0-9_]+:[A-Za-z0-9_]+$/);
    assert.ok(e.text.length > 0 && !e.text.endsWith("."), key);
    assert.ok(Array.isArray(e.snippet) && e.snippet.length > 0 && e.snippet.every((l) => typeof l === "string"), `${key}: snippet`);
    assert.match(key, /^\/Script\/(Engine|UMG|CoreUObject|SlateCore|Slate)\./, `${key}: engine module`);
  }
});

test("describeFunction: curated entry, tooltip fallback, generic fallback", () => {
  const table = loadDescriptions();
  assert.equal(describeFunction(table, "/Script/Engine.Controller", "K2_GetPawn"), "Returns the pawn this controller possesses (Get Controlled Pawn).");
  assert.equal(describeFunction(table, "/Script/Engine.Actor", "FlushNetDormancyNow"), "Calls Actor.FlushNetDormancyNow (Flush Net Dormancy Now).");
  assert.equal(
    describeFunction(table, "/Script/Engine.Actor", "FlushNetDormancyNow", { tooltip: "Does a thing. Then more.\nSecond line", displayName: "Flush It" }),
    "Does a thing (Flush It).",
  );
  assert.equal(describeFunction({ functions: {} }, "/Script/X.Y", "Foo", { tooltip: "Ends with dots..." }), "Ends with dots (Foo).");
});

test("emit: every function gets the description as its first JSDoc line, before @bpPath", () => {
  const text = emitStubs(input()).get("Script/Engine.d.ts") ?? "";
  const lines = text.split("\n");
  const first = (member: string): string[] => {
    const at = lines.findIndex((l) => l.startsWith(`  ${member}`));
    assert.ok(at > 0, member);
    const start = lines.lastIndexOf("  /**", at);
    return lines.slice(start + 1, at - 1).map((l) => l.replace("   * ", ""));
  };
  const curated = first("K2_DestroyActor(");
  assert.equal(curated[0], "Removes the actor from the world (Destroy Actor).");
  assert.equal(curated[1], `@bpPath ${ACTOR}:K2_DestroyActor`);
  const plain = first("FlushNetDormancyNow(");
  assert.equal(plain[0], "Calls Actor.FlushNetDormancyNow (Flush Net Dormancy Now).");
  assert.equal(plain[1], `@bpPath ${ACTOR}:FlushNetDormancyNow`);
});

test("emit: reflected function metadata feeds the description of an uncurated function; the curated text still wins", () => {
  const inp = input();
  const cls = (inp.reflect.classes as Record<string, { functions: { name: string; meta?: unknown }[] }>)[ACTOR]!;
  for (const f of cls.functions) {
    if (f.name === "FlushNetDormancyNow") f.meta = { tooltip: "Forces a flush */ of the thing. Extra text.\n@param X ignored", displayName: "Flush Dormancy Now" };
    if (f.name === "K2_DestroyActor") f.meta = { tooltip: "Reflected text", displayName: "Reflected Name" };
  }
  const text = emitStubs(inp).get("Script/Engine.d.ts") ?? "";
  assert.ok(text.includes(" * Forces a flush * / of the thing (Flush Dormancy Now).\n"));
  assert.ok(text.includes(" * Removes the actor from the world (Destroy Actor).\n"));
  assert.ok(!text.includes("Reflected text"));
});

test("TS quick info of a stub method shows the description", () => {
  const stub = (emitStubs(input()).get("Script/Engine.d.ts") ?? "").split("\n").filter((l) => !l.startsWith("import ")).join("\n");
  const consumer = 'import { Actor } from "./stub";\ndeclare const a: Actor;\na.K2_DestroyActor();\n';
  const files = new Map<string, string>([
    ["/virt/stub.d.ts", stub],
    ["/virt/consumer.ts", consumer],
  ]);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({ strict: true, noEmit: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, types: [] }),
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (f) => (files.has(f) ? ts.ScriptSnapshot.fromString(files.get(f)!) : undefined),
    getCurrentDirectory: () => "/virt",
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => files.has(f) || ts.sys.fileExists(f),
    readFile: (f) => files.get(f) ?? ts.sys.readFile(f),
  };
  const ls = ts.createLanguageService(host);
  const pos = consumer.indexOf("K2_DestroyActor") + 3;
  const qi = ls.getQuickInfoAtPosition("/virt/consumer.ts", pos);
  assert.ok(qi, "quick info");
  assert.match(ts.displayPartsToString(qi.documentation), /^Removes the actor from the world \(Destroy Actor\)\./);
});
