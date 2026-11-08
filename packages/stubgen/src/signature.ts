// Parameter lists, return types and the @bpPin/@bpParam/@bpOut tags shared by reflected and hand-made members.
import { ident } from "./names.js";
import { isUnsupported, tsOfGrammar, unsupportedLabel } from "./typemap.js";
import type { TypeCtx } from "./typemap.js";

export interface SigPin {
  /** Real pin name. */
  pin: string;
  grammar: string;
  /** Default text of the pin from the engine's metadata (backend 2.6.0: the parameter-name key, then `CPP_Default_*`) or the curated zero defaults (curated.ts); undefined = no default. */
  default?: string;
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
  // the longest trailing run of inputs that all have a C++ default is optional (TS needs optional parameters last)
  let firstOptional = ins.length;
  while (firstOptional > 0 && ins[firstOptional - 1]?.default !== undefined) firstOptional--;
  const params = ins.map((p, i) => {
    note(p);
    if (isUnsupported(p.grammar)) unsupported.add(unsupportedLabel(p.grammar));
    return `${tsName(p.pin)}${i >= firstOptional ? "?" : ""}: ${tsOfGrammar(p.grammar, ctx, "param")}`;
  });
  for (const p of ins) tags.push(`@bpParam ${p.pin} ${p.grammar}`);
  ins.forEach((p, i) => {
    if (i >= firstOptional && p.default !== undefined) tags.push(`@bpDefault ${p.pin} ${JSON.stringify(p.default)}`);
  });
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
