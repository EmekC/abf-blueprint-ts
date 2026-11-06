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
  /** Class defaults from the `@blueprint` options (pin names -> T3D text); filled by the class-defaults pass. */
  defaults: Record<string, string>;
  /** Row asset path of the `classManagerRow` option (verified, not written). */
  classManagerRow?: string;
}

export interface HirEvent {
  name: string;
  /** `event`: custom event (`@event`); `override`: override of an event/function of a parent class (`@override`). */
  kind: "event" | "override";
  /** Class path of the engine class that declares the overridden event (from the stub's `@bpPath`); only for `override`. */
  overrideOf?: string;
  /** Text of the method's JSDoc comment. */
  doc?: string;
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
  | { k: "forOf"; local: LocalId; name: string; array: HirExpr; elem: BpType; body: HirStmt[]; span: Span }
  /** `this.X = c ? a : b`: Branch plus one set per side. */
  | { k: "setSelfCond"; name: string; type: BpType; cond: HirExpr; a: HirExpr; b: HirExpr; span: Span }
  /** `for (let i = A; cond; i++ | i--)` with an int counter; the counter is only visible in `cond` and `body`. */
  | { k: "forCount"; counter: LocalId; name: string; init: HirExpr; cond: HirExpr; step: 1 | -1; body: HirStmt[]; span: Span }
  /** Mutation of an own array variable: `push(x)`, `splice(i, 1)` (removeAt), `length = 0` (clear). `array.type` is the array type, e.g. "array:name". */
  | { k: "arrayOp"; op: "push" | "removeAt" | "clear"; array: { self: string; type: BpType }; value?: HirExpr; index?: HirExpr; span: Span };

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
  /** Call of an owned `@event`/`@override` of the same class (`this.RelayTick(dt)`); `args` use the event's parameter names as pins. */
  | { k: "callOwn"; name: string; args: Array<{ pin: string; value: HirExpr }> }
  /** A Blueprint class used as a value (`WBP_X_C` in a class-typed argument). */
  | { k: "classRef"; path: string }
  /** A reference to an owned event passed to a delegate-typed parameter (`this.ScanPlayers`). */
  | { k: "delegateRef"; event: string }
  /** Enum value as its T3D text. */
  | { k: "enumLit"; text: string; enumPath: string }
  | { k: "nameLit"; text: string }
  | { k: "createWidget"; cls: string; owner: HirExpr }
  | { k: "spawn"; cls: string; owner?: HirExpr; collision?: string; scale?: string }
  | { k: "arith"; op: "+" | "-" | "*"; kind: "int" | "real"; a: HirExpr; b: HirExpr }
  | { k: "cmp"; op: "<" | "<=" | ">" | ">="; kind: "int" | "real"; a: HirExpr; b: HirExpr }
  | { k: "index"; array: HirExpr; index: HirExpr; elem: BpType }
  /** `arr.indexOf(x)`: Array_Find (-1 when absent). `elem` is the element type. */
  | { k: "arrayFind"; array: HirExpr; value: HirExpr; elem: BpType }
) & { type: BpType | "void" | "null"; span: Span };

export interface HirProgram {
  mod: string;
  classes: HirClass[];
  classMeta: Record<string, string>;
  diagnostics: Diagnostic[];
}
