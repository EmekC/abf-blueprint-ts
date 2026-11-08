import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrModule, IrUnit, Profile } from "@abfc/ir";
import { buildHir, loadProgram, lower } from "../src/index.js";
import type { HirProgram } from "../src/index.js";

// compiled to packages/compiler/dist/test/ -> packages/compiler/test/fixtures/project and packages/env/profiles;
// the copy sits inside the package tree so that `@abfc/runtime` resolves.
const here = fileURLToPath(new URL("./", import.meta.url));
const projectDir = fileURLToPath(new URL("../../test/fixtures/project", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../env/profiles/ue5.4.4-1050002.json", import.meta.url));
export const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile;
export const config = { mod: "TestMod" };

/** The class asset path of `className` in the generated sources. */
export const ASSET = "/TestMod/Relay/BP_Printer";

/** A `BP_Printer` source: `members` is the class body (events, overrides, functions). */
export function classSource(members: string, parent = "Actor"): string {
  return `import { blueprint, event, override } from "@abfc/runtime";
import type { int, name, text, float } from "@abfc/runtime";
import { Actor, FakeController, KismetSystemLibrary } from "/Script/FakeEngine";

@blueprint({ path: "${ASSET}" })
export class BP_Printer extends ${parent} {
  Count!: int;
  Last!: int;
  Label!: string;
${members}
}
`;
}

export interface Compiled {
  hir: HirProgram;
  ir: IrModule | null;
}

/** HIR (and, when it has no diagnostics, the IR) of the given source files (name -> text); `Printer.ts` is the one compiled. */
export function compileFiles(files: Record<string, string>, target = "Printer.ts"): Compiled {
  const dir = mkdtempSync(join(here, "fn-"));
  try {
    cpSync(projectDir, dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "src", name), text, "utf8");
    const loaded = loadProgram(dir);
    const sf = loaded.files.classes.find((f) => f.fileName.endsWith("/" + target));
    assert.ok(sf);
    const hir = buildHir(loaded, config, profile, [sf]);
    const ir = hir.diagnostics.length === 0 ? lower(hir, profile) : null;
    return { hir, ir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compile a one-class project whose class body is `members`. */
export function compile(members: string, parent = "Actor"): Compiled {
  return compileFiles({ "Printer.ts": classSource(members, parent) });
}

/** The IR of a clean compile (asserts there are no diagnostics). */
export function irOf(members: string): IrModule {
  const c = compile(members);
  assert.deepEqual(c.hir.diagnostics.map((d) => `${d.code} ${d.message}`), []);
  assert.ok(c.ir);
  return c.ir;
}

export const unitById = (ir: IrModule, id: string): IrUnit => {
  const u = ir.assets[0]!.units.find((x) => x.id === id);
  assert.ok(u, `unit ${id}`);
  return u;
};

export const codes = (c: Compiled): string[] => c.hir.diagnostics.map((d) => d.code);
