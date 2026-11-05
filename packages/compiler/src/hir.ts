// High-level IR: the TypeScript subset after the frontend has resolved every name against the stubs.
// This file never imports `typescript`; later passes (lowering, planning) only see these shapes.
import type { Diagnostic, Span } from "@abfc/ir";

/** bp_apply type grammar, e.g. "int", "object:/Script/Engine.Actor", "array:name". */
export type BpType = string;

export interface HirClass {
  name: string;
  /** Package path, e.g. "/Mod/Dir/BP_X". */
  path: string;
  /** `<path>.<AssetName>_C`. */
  classPath: string;
  /** Class path of the parent (`@bpPath` of the `extends` class). */
  parent: string;
  span: Span;
  events: HirEvent[];
  /** Hand-made functions/events of the asset that the TS class sees through `<X>_Manual` (tag `@bpHandMade`). */
  manualUnits: string[];
}

export interface HirEvent {
  name: string;
  params: Array<{ name: string; type: BpType }>;
  body: HirStmt[];
  span: Span;
}

export type LocalId = number;

export type HirStmt =
  | { k: "expr"; e: HirExpr; span: Span }
  | { k: "setSelf"; name: string; type: BpType; value: HirExpr; span: Span }
  | { k: "const"; local: LocalId; name: string; init: HirExpr; uses: number; span: Span }
  | { k: "if"; cond: HirExpr; then: HirStmt[]; else: HirStmt[]; span: Span }
  | { k: "return"; span: Span }
  | { k: "forOf"; local: LocalId; name: string; array: HirExpr; elem: BpType; body: HirStmt[]; span: Span };

export type HirExpr = (
  | { k: "self" }
  | { k: "param"; name: string }
  | { k: "local"; id: LocalId }
  | { k: "lit"; value: string | number | boolean | null }
  | { k: "getSelf"; name: string }
  | { k: "getOn"; obj: HirExpr; owner: string; name: string }
  | { k: "field"; obj: HirExpr; struct: string; name: string } // struct member read -> BreakStruct
  | { k: "out"; call: HirExpr; pin: string } // multi-output / exec-result member
  | {
      k: "call";
      /** Owning class path of the function; null when it is a member of the unit's own class. */
      owner: string | null;
      name: string;
      /** null = the call is made on `this`. */
      target: HirExpr | null;
      static: boolean;
      pure: boolean;
      execOutputs: string[] | null;
      args: Array<{ pin: string; value: HirExpr }>;
      outs: Array<{ pin: string; type: BpType }>;
    }
  | { k: "cast"; value: HirExpr; target: string; castPin: string }
  | { k: "optional"; value: HirExpr; then: HirExpr } // a?.b : `then` refers to value via { k: "hole" }
  | { k: "hole" }
  | { k: "isValid"; value: HirExpr }
  | { k: "eq"; negate: boolean; a: HirExpr; b: HirExpr; kind: "object" | "name" | "string" | "int" | "real" | "bool" | "byte" }
  | { k: "not"; e: HirExpr }
  | { k: "and"; a: HirExpr; b: HirExpr }
  | { k: "or"; a: HirExpr; b: HirExpr }
  | { k: "length"; array: HirExpr; arrayType: BpType }
  | { k: "execIs"; local: LocalId; pin: string; negate: boolean }
) & { type: BpType | "void" | "null"; span: Span };

export interface HirProgram {
  mod: string;
  classes: HirClass[];
  classMeta: Record<string, string>;
  diagnostics: Diagnostic[];
}
