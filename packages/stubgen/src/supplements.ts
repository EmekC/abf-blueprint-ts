/**
 * Blueprint-visible engine properties the reflection cannot list (GetClassDefaults omits instanced subobject
 * properties such as UWidget::Slot). Keyed by the class path; `type` is a pin type grammar and `readonly`
 * marks properties a graph can read but not set.
 */
export const SUPPLEMENTAL_PROPERTIES: Readonly<Record<string, ReadonlyArray<{ name: string; type: string; readonly: boolean }>>> = {
  "/Script/UMG.Widget": [{ name: "Slot", type: "object:/Script/UMG.PanelSlot", readonly: true }],
};
