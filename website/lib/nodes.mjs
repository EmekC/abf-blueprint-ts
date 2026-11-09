// The node reference: one page per Blueprint-callable function of the stubs' /Script modules (website/data/node-signatures.json) plus the
// curated descriptions (packages/stubgen/data/descriptions.json). No npm imports, so the tests and the generator run without installing anything.
import { frontmatter } from "./docs-sync.mjs";

const isUpper = (c) => c >= "A" && c <= "Z";
const isLower = (c) => c >= "a" && c <= "z";
const isDigit = (c) => c >= "0" && c <= "9";
const isLetter = (c) => isUpper(c) || isLower(c);

/**
 * The name the Blueprint node editor shows for a function without a display-name override: `K2_GetPawn` -> `Get Pawn`,
 * `GetHUDClass` -> `Get HUD Class`. A copy of displayNameOf in packages/ir/src/displayname.ts; website/test/parity.test.mjs keeps them equal.
 */
export function displayNameOf(fn) {
  const s = fn.startsWith("K2_") ? fn.slice(3) : fn;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "_") {
      out += " ";
      continue;
    }
    const prev = i > 0 ? s[i - 1] : "";
    const next = i + 1 < s.length ? s[i + 1] : "";
    let space = false;
    if (prev !== "") {
      if (isUpper(c)) {
        if (isLower(prev)) space = true;
        else if (isDigit(prev)) space = isLower(next);
        else if (isUpper(prev) && isLower(next)) space = true;
      } else if (isDigit(c) && isLetter(prev)) {
        space = true;
      }
    }
    if (space) out += " ";
    out += c;
  }
  return out.replace(/ +/g, " ").trim();
}

const KEY = /^(\/[^:]*)\.([A-Za-z0-9_]+):([A-Za-z0-9_]+)$/;
export const seg = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Page path of a node on the site: `/Script/Engine.KismetSystemLibrary:PrintString` -> `reference/nodes/kismetsystemlibrary-printstring`. Throws on a malformed key. */
export function nodeSlug(key) {
  const m = KEY.exec(key);
  if (m === null) throw new Error(`docs: not a function key: ${key}`);
  return `reference/nodes/${seg(m[2])}-${seg(m[3])}`;
}

/** The short name of a module path: `/Script/Engine` -> `Engine`. */
export const moduleName = (path) => path.slice(path.lastIndexOf("/") + 1);

/** Page path of a module on the site: `/Script/Engine` -> `reference/modules/engine`. */
export const moduleSlug = (path) => `reference/modules/${seg(moduleName(path))}`;

/** `s` safe inside HTML text and double-quoted attributes. */
export const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const RESERVED = new Set(
  ("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in " +
    "instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package " +
    "private protected public await async of type").split(" "),
);

/** The variable name a snippet uses for an instance of `owner`: `TextBlock` -> `textBlock`, `HUD` -> `hud`, `AIController` -> `aiController`. */
export function receiverName(owner) {
  const name = owner.replace(/^[A-Z]+(?=[A-Z][a-z])|^[A-Z]+$|^[A-Z]/, (m) => m.toLowerCase());
  return RESERVED.has(name) ? `${name}Ref` : name;
}

/** A value for a required parameter in a generated snippet. `param` is `{ name, type }` of a node-signatures.json entry. */
export function placeholder(param) {
  const t = param.type.replace(/\s*\|\s*null$/, "");
  if (t === "boolean") return "true";
  if (t === "int" || t === "int64" || t === "byte" || t === "number") return "0";
  if (t === "float" || t === "double") return "0.0";
  if (t === "string") return '"text"';
  if (t === "text") return '"Text"';
  if (t === "name") return '"Name"';
  if (t === "DelegateRef") return "this.OnEvent";
  if (t.endsWith("[]")) return "[]";
  if (t.startsWith('"')) {
    const lit = /^"[^"]*"/.exec(t);
    if (lit !== null) return lit[0];
  }
  const name = param.name.charAt(0).toLowerCase() + param.name.slice(1);
  return RESERVED.has(name) ? `${name}Value` : name;
}

/** The example of a function without a hand-written one: `sig` is an entry of node-signatures.json. Returns the lines of a TypeScript snippet. */
export function generatedSnippet(sig) {
  const isMethod = sig.kind === "method";
  const callee = isMethod ? receiverName(sig.owner) : sig.owner;
  const required = sig.params.filter((p) => !p.optional);
  const args = required.map(placeholder);
  const lines = [`import { ${sig.owner} } from "${sig.module}";`, ""];
  if (isMethod) lines.push(`// ${callee}: a ${sig.owner} (or this, in a class that extends ${sig.owner})`);
  if (sig.latent) lines.push("// inside an @event: the statements after this call run when the node finishes");
  if (required.some((p) => p.type.replace(/\s*\|\s*null$/, "") === "DelegateRef")) lines.push("// OnEvent is an @event method of this class");
  let assign = "";
  const ret = sig.returns ?? { type: "void", fields: null };
  if (ret.type !== "void") {
    if (Array.isArray(ret.fields)) {
      assign = `const { ${ret.fields.join(", ")} } = `;
    } else {
      const base = ret.type.replace(/\s*\|\s*null$/, "");
      let name = "result";
      if (/^[A-Z][A-Za-z0-9_]*$/.test(base)) {
        const candidate = receiverName(base);
        const used = args.some((a) => new RegExp(`(^|[^A-Za-z0-9_$.])${candidate}($|[^A-Za-z0-9_$])`).test(a));
        if (candidate !== callee && !used) name = candidate;
      }
      assign = `const ${name} = `;
    }
  }
  lines.push(`${assign}${callee}.${sig.tsName}(${args.join(", ")});`);
  return lines;
}

const PURE_TITLE = "No execution pins; runs when its value is read";
const LATENT_TITLE = "Waits; call it in an @event, not in a function";
const WORLD_TITLE = "abfc fills the world context pin for you";

/**
 * The nodes to document, in key order: every function of `signatures` plus every curated function of `descriptions` (the parsed
 * descriptions.json). `signatures` is the parsed node-signatures.json (or undefined), `base` the site's base path, e.g. `/abf-blueprint-ts`.
 * Throws when a key is malformed, a curated entry has no snippet or two keys share a page.
 */
export function buildNodes(descriptions, signatures, base) {
  const nodes = [];
  const seen = new Map();
  const problems = [];
  const curatedTable = descriptions.functions ?? {};
  const keys = [...new Set([...Object.keys(signatures?.functions ?? {}), ...Object.keys(curatedTable)])].sort();
  for (const key of keys) {
    const curatedEntry = curatedTable[key];
    const curated = curatedEntry !== undefined;
    const m = KEY.exec(key);
    if (m === null) {
      problems.push(`not a function key: ${key}`);
      continue;
    }
    if (curated && (!Array.isArray(curatedEntry.snippet) || curatedEntry.snippet.length === 0)) {
      problems.push(`no snippet for ${key}`);
      continue;
    }
    const sig = signatures?.functions?.[key];
    if (curated && sig === undefined) console.warn(`docs: no signature for ${key}; run scripts/docs-node-signatures.mjs`);
    const slug = nodeSlug(key);
    if (seen.has(slug)) {
      problems.push(`${key} and ${seen.get(slug)} share the page ${slug}`);
      continue;
    }
    seen.set(slug, key);
    const owner = sig?.owner ?? m[2];
    const tsName = sig?.tsName ?? m[3];
    const module = sig?.module ?? m[1];
    const qualified = `${owner}.${tsName}`;
    const title = curatedEntry?.displayName ?? sig?.displayName ?? displayNameOf(m[3]);
    const text = curated ? curatedEntry.text : "";
    const blocked = sig?.blocked ?? null;
    const unsupported = sig?.unsupported ?? [];
    const pure = sig?.pure === true;
    const latent = sig?.latent === true;
    const worldContext = sig?.worldContext === true;
    const modName = moduleName(module);
    const badges = [{ cls: "note", label: "Blueprint node", title: "A function a Blueprint node can call" }];
    if (pure) badges.push({ cls: "pure", label: "Pure", title: PURE_TITLE });
    if (latent) badges.push({ cls: "latent", label: "Latent", title: LATENT_TITLE });
    if (worldContext) badges.push({ cls: "world", label: "World context", title: WORLD_TITLE });
    if (blocked !== null) badges.push({ cls: "blocked", label: "Blocked", title: "The Blueprint filter blocks this node in mods" });
    const notes = [];
    for (const label of unsupported) {
      if (label === "delegate") {
        notes.push({
          type: "note",
          html:
            "The delegate pin takes <code>this.&lt;EventName&gt;</code>, a reference to an <code>@event</code> method of the same class. " +
            `Anything else is error <a href="${base}/reference/errors/#abfc2054">ABFC2054</a>.`,
        });
      } else {
        notes.push({ type: "caution", html: `A pin of this node has a type abfc cannot pass yet (<code>${escapeHtml(label)}</code>).` });
      }
    }
    if (blocked !== null) {
      notes.push({
        type: "caution",
        html: `${escapeHtml(blocked)}. Mods cannot use this node: abfc reports error <a href="${base}/reference/errors/#abfc7011">ABFC7011</a> when code calls it.`,
      });
    }
    let snippet = null;
    if (curated) snippet = curatedEntry.snippet;
    else if (blocked === null && sig !== undefined) snippet = generatedSnippet(sig);
    nodes.push({
      key,
      slug,
      url: `${base}/${slug}/`,
      module,
      moduleName: modName,
      moduleUrl: `${base}/${moduleSlug(module)}/#${seg(owner)}`,
      owner,
      fn: m[3],
      tsName,
      kind: sig?.kind ?? "static",
      qualified,
      title,
      curated,
      text,
      description: curated ? `${text}.` : `${title}: the Blueprint node behind ${qualified} (${modName} module).`,
      snippet,
      params: sig?.params ?? [],
      returns: sig?.returns ?? { type: "void", fields: null },
      signature: sig?.signature ?? null,
      pure,
      latent,
      worldContext,
      unsupported,
      blocked,
      badges,
      notes,
    });
  }
  if (problems.length > 0) throw new Error(`docs: node reference problems:\n  ${problems.join("\n  ")}`);
  return nodes;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The modules that have functions in `signatures` (the parsed node-signatures.json): `[{ path, name, slug, count }]`, sorted by name. */
export function modulesOf(signatures) {
  const counts = new Map();
  for (const sig of Object.values(signatures.functions)) counts.set(sig.module, (counts.get(sig.module) ?? 0) + 1);
  return [...counts]
    .map(([path, count]) => ({ path, name: moduleName(path), slug: moduleSlug(path), count }))
    .sort((a, b) => byText(a.name, b.name));
}

const flagsOf = (n) =>
  [n.pure ? "Pure" : "", n.latent ? "Latent" : "", n.worldContext ? "World context" : "", n.blocked !== null ? "Blocked" : ""].filter((s) => s !== "").join(", ");

/** One entry per module for the module pages: `[{ path, name, slug, url, count, owners: [{ name, id, rows: [{ title, url, qualified, flags }] }] }]`. */
export function modulePages(nodes) {
  const byModule = new Map();
  for (const n of nodes) {
    if (!byModule.has(n.module)) byModule.set(n.module, []);
    byModule.get(n.module).push(n);
  }
  return [...byModule]
    .map(([path, list]) => {
      const owners = new Map();
      for (const n of list) {
        if (!owners.has(n.owner)) owners.set(n.owner, []);
        owners.get(n.owner).push(n);
      }
      return {
        path,
        name: moduleName(path),
        slug: moduleSlug(path),
        url: list[0].moduleUrl.split("#")[0],
        count: list.length,
        owners: [...owners]
          .map(([name, members]) => ({
            name,
            id: seg(name),
            rows: members
              .map((n) => ({ title: n.title, url: n.url, qualified: n.qualified, flags: flagsOf(n) }))
              .sort((a, b) => byText(a.title, b.title) || byText(a.qualified, b.qualified)),
          }))
          .sort((a, b) => byText(a.name, b.name)),
      };
    })
    .sort((a, b) => byText(a.name, b.name));
}

const escapeCell = (s) => s.replace(/\|/g, "\\|");

/** The Markdown text of `reference/nodes/index.md`: what is listed, the naming rule, the modules and the documented nodes. `modules` come from modulePages. */
export function nodesIndexPage(nodes, modules, meta, base) {
  const out = [
    frontmatter({
      title: "Node reference",
      description: "Every Blueprint-callable function of the engine and game modules: node name, TypeScript name and an example.",
      sidebar: { label: "Overview", order: 0 },
    }).trimEnd(),
    "",
    `Every function of the engine and game modules that a Blueprint can call has a page here: ${nodes.length} functions in ${modules.length} modules, ` +
      `read from the stubs of Mod Editor ${meta.modEditorVersion} (generator ${meta.generator}). ` +
      "Search (Ctrl+K) finds a node by its Blueprint name, its TypeScript name or a few of its letters.",
    "",
    "A node's TypeScript name is the C++ function name behind it. Often that is the node name without spaces, but it can differ (a `K2_` prefix, or a renamed node): " +
      "**Set Timer by Event** is `KismetSystemLibrary.K2_SetTimerDelegate`. Each page shows both names, and search finds a node by either. " +
      `Errors you can hit while calling a node are listed on the [errors page](${base}/reference/errors/).`,
    "",
    "## Modules",
    "",
    "| Module | Functions |",
    "| --- | --- |",
    ...modules.map((m) => `| [${m.name}](${m.url}) | ${m.count} |`),
    "",
    "## Documented nodes",
    "",
    "These have a hand-written description and example:",
    "",
    "| Node | TypeScript | What it does |",
    "| --- | --- | --- |",
  ];
  for (const n of nodes.filter((x) => x.curated).sort((a, b) => a.title.localeCompare(b.title))) {
    out.push(`| [${n.title}](${base}/${n.slug}/) | \`${n.qualified}\` | ${escapeCell(n.text)} |`);
  }
  out.push(
    "",
    "A function your stubs have but this list does not (another project, a newer game build) is still callable: editor completion finds it.",
    "",
  );
  return out.join("\n");
}

/** The Markdown text of `404.md`. */
export function notFoundPage(base) {
  return [
    "---",
    'title: "Page not found"',
    "pagefind: false",
    "editUrl: false",
    "---",
    "",
    "There is no page at this address. If an editor link brought you here, the node reference does not list that function yet: it is built from one set of generated stubs. " +
      `Search (Ctrl+K) for the node's name, or open the [node reference](${base}/reference/nodes/).`,
    "",
  ].join("\n");
}

/** The text of `llms-nodes.txt`: one line per function with its node name, TypeScript name, signature and flags. `siteUrl` is the site origin plus base path. */
export function llmsNodesText(nodes, siteUrl, meta) {
  const out = [
    "# abfc node reference",
    "",
    `> Every Blueprint-callable function of the engine and game modules (${nodes.length} functions) with its Blueprint node name, TypeScript name and signature. ` +
      `Stubs: Mod Editor ${meta.modEditorVersion}, generator ${meta.generator}.`,
  ];
  const modules = [...new Set(nodes.map((n) => n.module))].sort();
  for (const module of modules) {
    out.push("", `## ${module}`, "");
    for (const n of nodes.filter((x) => x.module === module)) {
      const params = n.params.map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`).join(", ");
      const flags = flagsOf(n).toLowerCase();
      out.push(`- [${n.title}](${siteUrl}/${n.slug}/): \`${n.qualified}(${params}): ${n.returns.type}\`${flags === "" ? "" : ` (${flags})`}`);
    }
  }
  out.push("");
  return out.join("\n");
}
