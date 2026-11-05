export interface HirUnit {
  name: string;
  nodes: { kind: string; span: import("../../ir/src/index.js").Span }[];
}
