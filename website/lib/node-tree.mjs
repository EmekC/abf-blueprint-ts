// The sidebar tree of the node reference (Module > Class > Function): the data built from modulePages, the lookup of the current page in it,
// the HTML of the parts the server renders and the browser script that fills the rest on demand. No imports, so it runs in Node and in the browser.

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The tree data from the `modulePages` output: `{ count, modules: [{ name, id, count, classes: [{ name, id, count, fns: [[title, page] | [title, page, 1]] }] }] }`. */
export function nodeTree(modules) {
  const mods = modules.map((m) => {
    const classes = m.owners.map((o) => ({
      name: o.name,
      id: o.id,
      count: o.rows.length,
      fns: o.rows.map((row) => {
        const page = row.slug.slice("reference/nodes/".length);
        return row.blocked ? [row.title, page, 1] : [row.title, page];
      }),
    }));
    return {
      name: m.name,
      id: m.slug.slice("reference/modules/".length),
      count: classes.reduce((sum, c) => sum + c.count, 0),
      classes,
    };
  });
  return { count: mods.reduce((sum, m) => sum + m.count, 0), modules: mods };
}

/** What `locateInTree` returns for a page that is not part of the node reference. */
export const NOWHERE = { kind: "other", moduleId: null, classId: null, page: null };

/** Where a page is in the tree: `{ kind: "node" | "module" | "overview" | "other", moduleId, classId, page }`. */
export function locateInTree(tree, pathname, base) {
  let rest = base !== "" && pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  if (!rest.endsWith("/") && !rest.slice(rest.lastIndexOf("/") + 1).includes(".")) rest += "/";
  if (rest === "/reference/nodes/") return { kind: "overview", moduleId: null, classId: null, page: null };
  const node = /^\/reference\/nodes\/([a-z0-9-]+)\/$/.exec(rest);
  if (node !== null) {
    const page = node[1];
    for (const m of tree.modules) {
      for (const c of m.classes) {
        if (c.fns.some((fn) => fn[1] === page)) return { kind: "node", moduleId: m.id, classId: c.id, page };
      }
    }
    return NOWHERE;
  }
  const mod = /^\/reference\/modules\/([a-z0-9-]+)\/$/.exec(rest);
  if (mod !== null && tree.modules.some((m) => m.id === mod[1])) return { kind: "module", moduleId: mod[1], classId: null, page: null };
  return NOWHERE;
}

/** The `<li>` rows of a class's functions; `hrefPrefix` goes before the page slug, `currentPage` gets `aria-current`. */
export function functionItemsHtml(cls, currentPage, hrefPrefix) {
  return cls.fns
    .map(([title, page, blocked]) => `<li><a href="${hrefPrefix}${page}/"${page === currentPage ? ' aria-current="page"' : ""}${blocked ? ' class="blocked"' : ""}>${esc(title)}</a></li>`)
    .join("");
}

/** The `<li>` rows of a module: its overview link and one collapsed class group each (the current class is open with its functions). */
export function classItemsHtml(mod, where, base) {
  const overview = `<li><a href="${base}/reference/modules/${mod.id}/"${where.kind === "module" && where.moduleId === mod.id ? ' aria-current="page"' : ""}>${esc(mod.name)} overview</a></li>`;
  const classes = mod.classes.map((c) => {
    const open = where.kind === "node" && where.moduleId === mod.id && where.classId === c.id;
    return `<li><details data-module="${mod.id}" data-class="${c.id}"${open ? " open" : ""}><summary><span class="node-tree__name">${esc(c.name)}</span><span class="node-tree__count">${c.count}</span></summary><ul${open ? "" : " data-lazy"}>${open ? functionItemsHtml(c, where.page, "../") : ""}</ul></details></li>`;
  });
  return overview + classes.join("");
}

/** The `<li>` rows of all modules; the current module is open with its classes. */
export function moduleItemsHtml(tree, where, base) {
  return tree.modules
    .map((m) => {
      const open = (where.kind === "node" || where.kind === "module") && where.moduleId === m.id;
      return `<li><details data-module="${m.id}"${open ? " open" : ""}><summary><span class="node-tree__name">${esc(m.name)}</span><span class="node-tree__count">${m.count}</span></summary><ul${open ? "" : " data-lazy"}>${open ? classItemsHtml(m, where, base) : ""}</ul></details></li>`;
    })
    .join("");
}

/** Browser only: fills the lists of the module and class groups from `node-tree.json` when the user opens them. */
export function initNodeTree(doc) {
  const root = doc.getElementById("node-tree");
  if (root === null) return;
  const base = root.dataset.base ?? "";
  let loading = null;
  const load = () => {
    if (loading === null) {
      loading = fetch(`${base}/node-tree.json?v=${encodeURIComponent(root.dataset.version ?? "")}`)
        .then((r) => {
          if (!r.ok) throw new Error(`node-tree.json: ${r.status}`);
          return r.json();
        })
        .catch((err) => {
          loading = null;
          throw err;
        });
    }
    return loading;
  };
  root.addEventListener(
    "toggle",
    (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement) || !details.open) return;
      const list = details.querySelector(":scope > ul[data-lazy]");
      if (list === null) return;
      list.removeAttribute("data-lazy");
      list.innerHTML = '<li class="node-tree__status" role="status">Loading…</li>';
      const moduleId = details.dataset.module;
      load()
        .then((tree) => {
          const mod = tree.modules.find((m) => m.id === moduleId);
          if (mod === undefined) throw new Error(`unknown module ${moduleId}`);
          if (details.dataset.class === undefined) {
            list.innerHTML = classItemsHtml(mod, NOWHERE, base);
            return;
          }
          const cls = mod.classes.find((c) => c.id === details.dataset.class);
          if (cls === undefined) throw new Error(`unknown class ${details.dataset.class}`);
          list.innerHTML = functionItemsHtml(cls, null, `${base}/reference/nodes/`);
        })
        .catch(() => {
          list.setAttribute("data-lazy", "");
          list.innerHTML = `<li class="node-tree__status">Could not load this list. <a href="${base}/reference/modules/${moduleId}/">Open the module page</a>.</li>`;
        });
    },
    true,
  );
}

/** Inline script (run after Starlight's scroll restore): scrolls the sidebar so the current tree link is visible, also when the mobile menu opens. */
export const REVEAL_SCRIPT = `(() => { try {
const scroller = document.getElementById("starlight__sidebar");
const current = document.querySelector('#node-tree a[aria-current="page"]');
if (!scroller || !current) return;
const reveal = () => {
  const s = scroller.getBoundingClientRect();
  const c = current.getBoundingClientRect();
  if (s.height === 0 || (c.top >= s.top && c.bottom <= s.bottom)) return;
  scroller.scrollTop += c.top - s.top - (s.height - c.height) / 2;
};
reveal();
scroller.addEventListener("toggle", (e) => { if (e.newState === "open") reveal(); });
} catch {} })();`;
