import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateIrModule } from "@abfc/ir";
import type { IrModule, IrNode, IrUnit, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import type { HirExpr, HirProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/project and packages/env/profiles;
// the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
const config = { mod: "TestMod" };

function source(body: string): string {
  return `import { blueprint, event } from "@abfc/runtime";
import type { int, name, text } from "@abfc/runtime";
import { Actor, KismetSystemLibrary } from "/Script/FakeEngine";

@blueprint({ path: "/TestMod/Relay/BP_Printer" })
export class BP_Printer extends Actor {
  Count!: int;
  Label!: string;
  Line!: text;
  Tag!: name;
  @event
  Hello(): void {
${body}
  }
}
`;
}

/** HIR (and, when it has no diagnostics, the IR) of a one-event BP_Printer whose body is `body`. */
function compile(body: string): { hir: HirProgram; ir: IrModule | null } {
  const dir = mkdtempSync(join(here, "tmpl-"));
  try {
    cpSync(projectDir, dir, { recursive: true });
    writeFileSync(join(dir, "src", "Printer.ts"), source(body), "utf8");
    const loaded = loadProgram(dir);
    const sf = loaded.files.classes.find((f) => f.fileName.endsWith("/Printer.ts"));
    assert.ok(sf);
    const hir = buildHir(loaded, config, profile, [sf]);
    const ir = hir.diagnostics.length === 0 ? lower(hir, profile) : null;
    return { hir, ir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const unitOf = (ir: IrModule): IrUnit => ir.assets[0]!.units[0]!;
const byFn = (u: IrUnit, name: string): IrNode[] => u.nodes.filter((n) => n.sem?.k === "call" && n.sem.function === name);
const fmtNodes = (u: IrUnit): IrNode[] => u.nodes.filter((n) => n.t3d.class === profile.nodeClasses.formatText);
const wired = (u: IrUnit, from: string, to: string): boolean => u.wires.some((w) => w[0] === from && w[1] === to);

/** Every `formatText` expression anywhere in the (statement/expression) value, arrays and objects included. */
function findFormatText(v: unknown, out: HirExpr[] = []): HirExpr[] {
  if (Array.isArray(v)) {
    for (const x of v) findFormatText(x, out);
  } else if (v && typeof v === "object") {
    if ((v as { k?: unknown }).k === "formatText") out.push(v as HirExpr);
    for (const x of Object.values(v)) findFormatText(x, out);
  }
  return out;
}

const formatTexts = (hir: HirProgram): Extract<HirExpr, { k: "formatText" }>[] =>
  findFormatText(hir.classes.flatMap((c) => c.events.map((e) => e.body))) as Extract<HirExpr, { k: "formatText" }>[];

test("PrintString with a template literal: FormatText -> Conv_TextToString -> PrintString", () => {
  const { hir, ir } = compile("    KismetSystemLibrary.PrintString(`Hello World From Typescript ${this.Count}`);");
  assert.deepEqual(hir.diagnostics, []);
  assert.ok(ir);
  assert.deepEqual(validateIrModule(ir), []);
  const fts = formatTexts(hir);
  assert.equal(fts.length, 1);
  assert.equal(fts[0]!.type, "string");
  const u = unitOf(ir);
  const fmts = fmtNodes(u);
  assert.equal(fmts.length, 1);
  const fmt = fmts[0]!;
  assert.equal(fmt.pinDefaults?.Format, "Hello World From Typescript {Count}");
  assert.deepEqual(fmt.t3d.props, ['PinNames(0)="Count"']);
  assert.deepEqual(fmt.pinTypes, { Count: "int" });
  const convs = byFn(u, "Conv_TextToString");
  assert.equal(convs.length, 1);
  const conv = convs[0]!;
  assert.deepEqual(conv.sem, { k: "call", class: "/Script/Engine.KismetTextLibrary", function: "Conv_TextToString" });
  assert.ok(conv.t3d.props?.includes("bIsPureFunc=True"));
  const prints = byFn(u, "PrintString");
  assert.equal(prints.length, 1);
  const print = prints[0]!;
  assert.ok(wired(u, `${fmt.id}.Result`, `${conv.id}.InText`));
  assert.ok(wired(u, `${conv.id}.ReturnValue`, `${print.id}.InString`));
  assert.equal(print.pinDefaults?.InString, undefined);
});

test("a const template literal with no type is a string", () => {
  const { hir, ir } = compile("    const s = `n ${this.Count}`;\n    KismetSystemLibrary.PrintString(s);");
  assert.deepEqual(hir.diagnostics, []);
  assert.ok(ir);
  assert.deepEqual(validateIrModule(ir), []);
  const consts = hir.classes[0]!.events[0]!.body.filter((s) => s.k === "const");
  assert.equal(consts.length, 1);
  const init = (consts[0] as { init: HirExpr }).init;
  assert.equal(init.k, "formatText");
  assert.equal((init as Extract<HirExpr, { k: "formatText" }>).type, "string");
  const u = unitOf(ir);
  const conv = byFn(u, "Conv_TextToString")[0]!;
  const print = byFn(u, "PrintString")[0]!;
  assert.ok(conv && print);
  assert.ok(wired(u, `${conv.id}.ReturnValue`, `${print.id}.InString`));
});

test("a template literal assigned to a string field goes through Conv_TextToString", () => {
  const { hir, ir } = compile("    this.Label = `n ${this.Count}`;");
  assert.deepEqual(hir.diagnostics, []);
  assert.ok(ir);
  assert.deepEqual(validateIrModule(ir), []);
  const u = unitOf(ir);
  const convs = byFn(u, "Conv_TextToString");
  assert.equal(convs.length, 1);
  const set = u.nodes.find((n) => n.t3d.class === profile.nodeClasses.variableSet);
  assert.ok(set);
  assert.ok(
    u.wires.some((w) => w[0] === `${convs[0]!.id}.ReturnValue` && w[1].startsWith(`${set.id}.`) && w[1].endsWith(".Label")),
    "Conv ReturnValue is wired into the VariableSet Label pin",
  );
});

test("text is unchanged: a template literal for a text field is plain FormatText", () => {
  const { hir, ir } = compile("    this.Line = `n ${this.Count}`;");
  assert.deepEqual(hir.diagnostics, []);
  assert.ok(ir);
  assert.deepEqual(validateIrModule(ir), []);
  const fts = formatTexts(hir);
  assert.equal(fts.length, 1);
  assert.equal(fts[0]!.type, "text");
  const u = unitOf(ir);
  const fmts = fmtNodes(u);
  assert.equal(fmts.length, 1);
  assert.equal(byFn(u, "Conv_TextToString").length, 0);
  const set = u.nodes.find((n) => n.t3d.class === profile.nodeClasses.variableSet);
  assert.ok(set);
  assert.ok(
    u.wires.some((w) => w[0] === `${fmts[0]!.id}.Result` && w[1].startsWith(`${set.id}.`) && w[1].endsWith(".Line")),
    "FormatText Result is wired into the VariableSet Line pin",
  );
});

test("a template literal where a name is expected is ABFC2099 with the conversion hint", () => {
  const { hir } = compile("    this.Tag = `n ${this.Count}`;");
  assert.deepEqual(hir.diagnostics.map((d) => d.code), ["ABFC2099"]);
  assert.match(hir.diagnostics[0]!.message, /cannot be a name/);
  assert.match(hir.diagnostics[0]!.message, /Conv_StringToName/);
});

test("a backtick string without substitutions is a string literal", () => {
  const { hir, ir } = compile("    KismetSystemLibrary.PrintString(`plain`);");
  assert.deepEqual(hir.diagnostics, []);
  assert.ok(ir);
  assert.deepEqual(validateIrModule(ir), []);
  const u = unitOf(ir);
  assert.equal(fmtNodes(u).length, 0);
  const prints = byFn(u, "PrintString");
  assert.equal(prints.length, 1);
  assert.equal(prints[0]!.pinDefaults?.InString, "plain");
});
