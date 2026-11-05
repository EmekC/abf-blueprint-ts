// Copy of design 6.1 (types only), spike P9.
export interface IrModule {
  irVersion: 1;
  profile: string;
  mod: string;
  assets: IrAsset[];
}
export interface IrAsset {
  path: string;
  create?: { kind: "Blueprint" | "WidgetBlueprint" | "BlueprintInterface" | "UserDefinedStruct"; parent: string };
  classDefaults?: Record<string, string>;
  variables: IrVariable[];
  units: IrUnit[];
  structFields?: IrVariable[];
}
export interface IrVariable { name: string; type: IrType; default?: string; flags: VarFlag[]; origin: Span; temp?: boolean }
export type VarFlag = "transient" | "editable" | "replicated" | "exposeOnSpawn" | "private";
export type IrType = string;
export interface IrParam { name: string; type: IrType }
export interface IrUnit {
  id: string;
  kind: "function" | "event" | "override";
  name: string;
  graph: string;
  signature: { inputs: IrParam[]; outputs: IrParam[]; net?: "server" | "client" | "multicast"; reliable?: boolean };
  locals: IrVariable[];
  nodes: IrNode[];
  wires: IrWire[];
  origin: Span;
  hash: string;
}
export interface IrNode {
  id: string;
  t3d: { class: string; props: string[] };
  sem?: SemanticTag;
  pinDefaults?: Record<string, string>;
  pinObjects?: Record<string, string>;
  pos: [number, number];
  origin: Span;
}
export type SemanticTag =
  | { k: "call"; class?: string; function: string } | { k: "get" | "set"; name: string; class?: string }
  | { k: "event"; name: string } | { k: "override"; class: string; function: string }
  | { k: "branch" } | { k: "sequence" } | { k: "cast"; target: string } | { k: "self" }
  | { k: "spawn" } | { k: "create_widget" } | { k: "call_dispatcher" | "bind_dispatcher"; name: string };
export type IrWire = [from: `${string}.${string}`, to: `${string}.${string}`];
export interface Span { file: string; line: number; col: number; endLine: number; endCol: number }
