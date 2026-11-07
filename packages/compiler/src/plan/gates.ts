import type { Diagnostic, IrModule, Span } from "@abfc/ir";

/** The part of the backend capabilities the feature gates look at (structural, so the compiler does not depend on the backend package). */
export interface GateCapabilities {
  containerTypes: { map: boolean; set: boolean };
  createKinds: string[];
}

/**
 * Feature gates: ABFC2044 for every Map or Set type (variable, struct field, local or pin type) the backend or abfc's native policy
 * does not allow, and for every asset created as a kind the backend cannot create. Runs before the stage is touched.
 */
export function featureGates(ir: IrModule, caps: GateCapabilities): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const need = (kind: "map" | "set", type: string, asset: string, span: Span): void => {
    if (caps.containerTypes[kind]) return;
    const key = `${asset}\n${kind}\n${type}\n${span.file}:${span.line}:${span.col}`;
    if (seen.has(key)) return;
    seen.add(key);
    const shown = kind === "map" ? "Map<...>" : "Set<...>";
    out.push({
      severity: "error",
      code: "ABFC2044",
      asset,
      span,
      message: `${shown} (${type}) needs a backend with ${kind} support (backend_info containerTypes.${kind} and abfc's native ${kind} policy); update the backend or remove the ${kind}.`,
    });
  };
  const check = (type: string, asset: string, span: Span): void => {
    if (type.startsWith("map:")) need("map", type, asset, span);
    else if (type.startsWith("set:")) need("set", type, asset, span);
  };
  for (const a of ir.assets) {
    for (const v of a.variables) check(v.type, a.path, v.origin);
    for (const v of a.structFields ?? []) check(v.type, a.path, v.origin);
    for (const u of a.units) {
      for (const v of u.locals) check(v.type, a.path, v.origin);
      for (const p of [...u.signature.inputs, ...u.signature.outputs]) {
        const origin = u.nodes[0]?.origin;
        if (origin) check(p.type, a.path, origin);
      }
      for (const n of u.nodes) for (const t of Object.values(n.pinTypes ?? {})) check(t, a.path, n.origin);
    }
    if (a.create !== undefined && !caps.createKinds.includes(a.create.kind)) {
      const span = a.variables[0]?.origin ?? a.units[0]?.nodes[0]?.origin ?? a.structFields?.[0]?.origin;
      out.push({
        severity: "error",
        code: "ABFC2044",
        asset: a.path,
        ...(span ? { span } : {}),
        message: `${a.path} needs a backend that can create a ${a.create.kind} (backend_info bpApply createKinds and abfc's native policy).`,
      });
    }
  }
  return out;
}
