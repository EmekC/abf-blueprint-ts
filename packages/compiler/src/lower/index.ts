// HIR -> IR lowering (design 6): one asset per class, one unit per event.
import type { IrAsset, IrModule, IrUnit, IrVariable, Profile } from "@abfc/ir";
import type { HirProgram } from "../hir.js";
import { UnitBuilder } from "./builder.js";

export { formatLiteral } from "./builder.js";
export { assignPositions } from "./layout.js";

export function lower(h: HirProgram, profile: Profile): IrModule {
  const assets: IrAsset[] = h.classes.map((cls) => {
    const variables: IrVariable[] = [];
    const units: IrUnit[] = [];
    for (const ev of cls.events) {
      const b = new UnitBuilder(profile, h.classMeta, ev);
      units.push(b.build());
      variables.push(...b.vars);
    }
    return {
      path: cls.path,
      variables,
      units,
      ...(Object.keys(cls.defaults).length > 0 ? { classDefaults: { ...cls.defaults } } : {}),
      ...(cls.classManagerRow !== undefined ? { classManagerRow: cls.classManagerRow } : {}),
    };
  });
  return { irVersion: 1, profile: profile.id, mod: h.mod, assets, classMeta: h.classMeta };
}
