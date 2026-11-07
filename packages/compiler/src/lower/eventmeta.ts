import type { EventMeta } from "@abfc/ir";

/** The backend's limit for an event's tooltip, category and keywords (bp_apply `event_meta`), in Unicode code points. */
export const EVENT_META_MAX = 2000;
export const CLAMP_MARK = "...";

/** Cuts a value longer than {@link EVENT_META_MAX} code points to exactly that length, ending with `...`. */
export function clampMeta(value: string): string {
  const cps = Array.from(value);
  return cps.length <= EVENT_META_MAX ? value : cps.slice(0, EVENT_META_MAX - CLAMP_MARK.length).join("") + CLAMP_MARK;
}

/** True when the value is the result of {@link clampMeta} cutting a longer text. */
export function isClamped(value: string): boolean {
  return Array.from(value).length === EVENT_META_MAX && value.endsWith(CLAMP_MARK);
}

/**
 * The Blueprint tooltip, category and keywords of an `@event` from its doc comment text (the `/** ... *\/` body without the stars):
 * the tooltip is every line before the first line that starts with `@`, joined with newlines and trimmed; `@category <text>` and
 * `@keywords <text>` fill the other two. undefined when all three are empty.
 */
export function eventMetaOf(doc: string): EventMeta | undefined {
  const lines = doc.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trimStart().startsWith("@"));
  const head = first < 0 ? lines : lines.slice(0, first);
  const meta: EventMeta = {};
  const tooltip = head.join("\n").trim();
  if (tooltip !== "") meta.tooltip = clampMeta(tooltip);
  const tag = (name: string): string | undefined => {
    for (const l of first < 0 ? [] : lines.slice(first)) {
      const m = new RegExp(`^\\s*@${name}(?:\\s+(.*))?$`).exec(l);
      if (m) {
        const v = (m[1] ?? "").trim();
        if (v !== "") return v;
      }
    }
    return undefined;
  };
  const category = tag("category");
  if (category !== undefined) meta.category = clampMeta(category);
  const keywords = tag("keywords");
  if (keywords !== undefined) meta.keywords = clampMeta(keywords);
  return Object.keys(meta).length === 0 ? undefined : meta;
}
