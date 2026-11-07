// One-line descriptions of stub functions: `<description> (<Node Name>).`
import { readFileSync } from "node:fs";
import { displayNameOf } from "@abfc/ir";

export interface DescriptionTable {
  functions: Record<string, { text: string; displayName?: string }>;
}

let cached: DescriptionTable | null = null;

/** The curated table shipped with the package (`data/descriptions.json`), read once. */
export function loadDescriptions(): DescriptionTable {
  if (cached === null) {
    const raw = JSON.parse(readFileSync(new URL("../../data/descriptions.json", import.meta.url), "utf8")) as { functions?: DescriptionTable["functions"] };
    cached = { functions: raw.functions ?? {} };
  }
  return cached;
}

const MAX_TOOLTIP = 160;

function firstSentence(text: string): string {
  const nl = text.search(/\r?\n/);
  let s = nl >= 0 ? text.slice(0, nl) : text;
  const dot = s.indexOf(". ");
  if (dot >= 0) s = s.slice(0, dot);
  return s.replace(/\*\//g, "* /").trim().slice(0, MAX_TOOLTIP).trim();
}

/** `<description> (<Display Name>).` for one function of `classPath`. */
export function describeFunction(
  table: DescriptionTable,
  classPath: string,
  fn: string,
  meta?: { tooltip?: string | null; displayName?: string | null },
): string {
  const entry = table.functions[`${classPath}:${fn}`];
  const short = classPath.slice(classPath.lastIndexOf(".") + 1);
  let desc = entry?.text ?? (meta?.tooltip ? firstSentence(meta.tooltip) : "");
  if (desc === "") desc = `Calls ${short}.${fn}`;
  desc = desc.replace(/\.+$/, "");
  const display = entry?.displayName ?? (meta?.displayName ? meta.displayName : displayNameOf(fn));
  return `${desc} (${display}).`;
}
