// Parameter lists, return types and the @bpPin/@bpParam/@bpOut tags shared by reflected and hand-made members.
import { ident } from "./names.js";
import { isUnsupported, tsOfGrammar, unsupportedLabel } from "./typemap.js";
import type { TypeCtx } from "./typemap.js";

export interface SigPin {
  /** Real pin name. */
  pin: string;
  grammar: string;
}

export interface Signature {
  /** `A: T, B: U` */
  params: string;
  /** Return type text. */
  ret: string;
  /** `@bpPin`, `@bpParam`, `@bpOut` and `@bpUnsupported` tag lines. */
  tags: string[];
}

function tsName(pin: string): string {
  return ident(pin);
}

/** `extraExec`: exec outputs other than `then` (ExpandEnumAsExecs), which turn the result into `{ exec: "A" | "B"; ... }`. */
export function buildSignature(ins: SigPin[], outs: SigPin[], extraExec: string[], ctx: TypeCtx): Signature {
  const tags: string[] = [];
  const unsupported = new Set<string>();
  const note = (p: SigPin): void => {
    const ts = tsName(p.pin);
    if (ts !== p.pin) tags.push(`@bpPin ${ts} ${JSON.stringify(p.pin)}`);
  };
  const params = ins.map((p) => {
    note(p);
    if (isUnsupported(p.grammar)) unsupported.add(unsupportedLabel(p.grammar));
    return `${tsName(p.pin)}: ${tsOfGrammar(p.grammar, ctx)}`;
  });
  for (const p of ins) tags.push(`@bpParam ${p.pin} ${p.grammar}`);
  const outTs = outs.map((p) => {
    note(p);
    if (isUnsupported(p.grammar)) unsupported.add(unsupportedLabel(p.grammar));
    return { name: tsName(p.pin), type: tsOfGrammar(p.grammar, ctx), pin: p.pin };
  });
  for (const p of outs) tags.push(`@bpOut ${p.pin} ${p.grammar}`);
  for (const u of [...unsupported].sort()) tags.push(`@bpUnsupported ${u}`);

  let ret: string;
  if (extraExec.length > 0) {
    ret = `{ exec: ${extraExec.map((x) => JSON.stringify(x)).join(" | ")};${outTs.map((o) => ` ${o.name}: ${o.type};`).join("")} }`;
  } else if (outTs.length === 0) {
    ret = "void";
  } else if (outTs.length === 1 && outTs[0]?.pin === "ReturnValue") {
    ret = outTs[0].type;
  } else {
    ret = `{ ${outTs.map((o) => `${o.name}: ${o.type}`).join("; ")} }`;
  }
  return { params: params.join(", "), ret, tags };
}
