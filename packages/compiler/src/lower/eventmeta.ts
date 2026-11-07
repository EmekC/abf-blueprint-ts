import type { EventMeta } from "@abfc/ir";

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
  if (tooltip !== "") meta.tooltip = tooltip;
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
  if (category !== undefined) meta.category = category;
  const keywords = tag("keywords");
  if (keywords !== undefined) meta.keywords = keywords;
  return Object.keys(meta).length === 0 ? undefined : meta;
}
