// Links from the editor to the documentation site (https://emekc.github.io/abf-blueprint-ts/).

/**
 * Root of the documentation site, with a trailing slash. The ESLint plugin (`packages/eslint-plugin/src/util.ts`) and the VS Code
 * extension repeat this value; the page slugs are a public contract because released builds link to them.
 */
export const DOCS_SITE_URL = "https://emekc.github.io/abf-blueprint-ts/";

const KEY = /^\/[^:]*\.([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/;
const segment = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * Page path of an engine function on the site: `/Script/Engine.KismetSystemLibrary:PrintString` gives
 * `reference/nodes/kismetsystemlibrary-printstring`. Same rule as `nodeSlug` in `website/lib/nodes.mjs` (a test keeps them equal).
 * Undefined when `bpPath` is not a function path.
 */
export function nodeDocsSlug(bpPath: string): string | undefined {
  const m = KEY.exec(bpPath);
  if (m === null) return undefined;
  return `reference/nodes/${segment(m[1]!)}-${segment(m[2]!)}`;
}

/**
 * The URL of the page of a Blueprint-callable `/Script` function (engine, UMG and game modules: every one has a page in the node reference);
 * undefined for `/Game` and `/Mod` members, which have none. A function missing from the site's index lands on its 404 page, which points to search.
 */
export function nodeDocsUrl(bpPath: string): string | undefined {
  if (!bpPath.startsWith("/Script/")) return undefined;
  const slug = nodeDocsSlug(bpPath);
  return slug === undefined ? undefined : `${DOCS_SITE_URL}${slug}/`;
}
