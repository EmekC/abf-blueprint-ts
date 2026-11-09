// The sidebar tree of the node reference: data, location of the current page, rendered HTML and the scroll reveal script.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildNodes, modulePages } from "../lib/nodes.mjs";
import { REVEAL_SCRIPT, classItemsHtml, functionItemsHtml, locateInTree, moduleItemsHtml, nodeTree } from "../lib/node-tree.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const descriptions = JSON.parse(readFileSync(join(root, "packages", "stubgen", "data", "descriptions.json"), "utf8"));
const signatures = JSON.parse(readFileSync(join(root, "website", "data", "node-signatures.json"), "utf8"));
const BASE = "/abf-blueprint-ts";
const nodes = buildNodes(descriptions, signatures, BASE);
const modules = modulePages(nodes);
const tree = nodeTree(modules);

const count = (text, needle) => text.split(needle).length - 1;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

describe("node tree data", () => {
  it("counts every node once", () => {
    assert.equal(tree.count, nodes.length);
    assert.equal(tree.modules.length, modules.length);
    tree.modules.forEach((m, i) => {
      const classTotal = m.classes.reduce((sum, c) => sum + c.count, 0);
      const rowTotal = modules[i].owners.reduce((sum, o) => sum + o.rows.length, 0);
      assert.equal(m.count, classTotal);
      assert.equal(m.count, rowTotal);
      assert.equal(m.id, modules[i].slug.slice("reference/modules/".length));
    });
  });

  it("lists valid page slugs and the blocked flag", () => {
    const slugs = new Set(nodes.map((n) => n.slug));
    let blocked = 0;
    for (const m of tree.modules) {
      for (const c of m.classes) {
        assert.equal(c.count, c.fns.length);
        for (const fn of c.fns) {
          assert.match(fn[1], /^[a-z0-9-]+$/);
          assert.ok(slugs.has(`reference/nodes/${fn[1]}`), fn[1]);
          if (fn[2] === 1) blocked += 1;
        }
      }
    }
    assert.equal(blocked, nodes.filter((n) => n.blocked !== null).length);
  });

  it("keeps the order of the module pages", () => {
    tree.modules.forEach((m, i) => {
      m.classes.forEach((c, j) => {
        assert.equal(c.fns[0][0], modules[i].owners[j].rows[0].title);
      });
    });
  });
});

describe("locateInTree", () => {
  it("finds a function page", () => {
    assert.deepEqual(locateInTree(tree, `${BASE}/reference/nodes/abioticcharacter-aim/`, BASE), {
      kind: "node",
      moduleId: "abioticfactor",
      classId: "abioticcharacter",
      page: "abioticcharacter-aim",
    });
  });

  it("finds the overview and module pages", () => {
    assert.equal(locateInTree(tree, `${BASE}/reference/nodes/`, BASE).kind, "overview");
    for (const path of [`${BASE}/reference/modules/engine/`, `${BASE}/reference/modules/engine`]) {
      assert.deepEqual(locateInTree(tree, path, BASE), { kind: "module", moduleId: "engine", classId: null, page: null });
    }
  });

  it("treats everything else as other", () => {
    for (const path of [`${BASE}/reference/modules/nope/`, `${BASE}/reference/nodes/nope-nope/`, `${BASE}/guides/install/`, `${BASE}/404.html`]) {
      assert.equal(locateInTree(tree, path, BASE).kind, "other", path);
    }
  });
});

describe("node tree HTML", () => {
  it("opens and highlights the current function", () => {
    const where = locateInTree(tree, `${BASE}/reference/nodes/abioticcharacter-aim/`, BASE);
    const html = moduleItemsHtml(tree, where, BASE);
    assert.equal(count(html, 'aria-current="page"'), 1);
    assert.match(html, /<a href="\.\.\/abioticcharacter-aim\/" aria-current="page">Activate Jetpack<\/a>/);
    assert.ok(html.includes('<details data-module="abioticfactor" open>'));
    assert.ok(html.includes('<details data-module="abioticfactor" data-class="abioticcharacter" open>'));
    assert.equal(count(html, " open>"), 2);
    assert.ok(html.includes('<details data-module="engine"><summary>'));
    assert.match(html, /<details data-module="engine"><summary>.*?<\/summary><ul data-lazy><\/ul>/);
    const cls = tree.modules.find((m) => m.id === "abioticfactor").classes.find((c) => c.id === "abioticcharacter");
    for (const fn of cls.fns) assert.ok(html.includes(`>${esc(fn[0])}</a>`), fn[0]);
  });

  it("opens the module on a module page", () => {
    const where = locateInTree(tree, `${BASE}/reference/modules/engine/`, BASE);
    const html = moduleItemsHtml(tree, where, BASE);
    assert.equal(count(html, "aria-current"), 1);
    assert.ok(html.includes(`href="${BASE}/reference/modules/engine/" aria-current="page"`));
    assert.equal(count(html, " open>"), 1);
    assert.equal(count(html, 'href="../'), 0);
    assert.equal(count(html, "data-class="), tree.modules.find((m) => m.id === "engine").classes.length);
  });

  it("renders the tree collapsed on other pages", () => {
    const html = moduleItemsHtml(tree, locateInTree(tree, `${BASE}/guides/install/`, BASE), BASE);
    assert.equal(count(html, " open>"), 0);
    assert.equal(count(html, "aria-current"), 0);
    assert.equal(count(html, "data-lazy"), modules.length);
    assert.ok(html.length < 4000, String(html.length));
  });

  it("renders function rows with escaping, the current mark and the blocked class", () => {
    const cls = { fns: [['A<B & "C"', "x-a"], ["Blocked", "x-b", 1]] };
    assert.equal(
      functionItemsHtml(cls, "x-b", "/p/"),
      '<li><a href="/p/x-a/">A&lt;B &amp; &quot;C&quot;</a></li><li><a href="/p/x-b/" aria-current="page" class="blocked">Blocked</a></li>',
    );
  });

  it("renders class rows of a module", () => {
    const mod = tree.modules[0];
    const html = classItemsHtml(mod, { kind: "other", moduleId: null, classId: null, page: null }, BASE);
    assert.ok(html.startsWith(`<li><a href="${BASE}/reference/modules/${mod.id}/">`));
    assert.equal(count(html, "data-class="), mod.classes.length);
  });
});

describe("REVEAL_SCRIPT", () => {
  const run = (scrollerRect, linkRect, withLink = true) => {
    const scroller = {
      scrollTop: 0,
      rect: scrollerRect,
      listener: null,
      getBoundingClientRect() {
        return this.rect;
      },
      addEventListener(type, fn) {
        this.listener = fn;
      },
    };
    const link = { getBoundingClientRect: () => linkRect };
    const doc = { getElementById: () => scroller, querySelector: () => (withLink ? link : null) };
    new Function("document", REVEAL_SCRIPT)(doc);
    return scroller;
  };

  it("centers a link below the visible area", () => {
    const scroller = run({ top: 100, bottom: 600, height: 500 }, { top: 900, bottom: 920, height: 20 });
    assert.equal(scroller.scrollTop, 560);
  });

  it("leaves a visible link alone", () => {
    const scroller = run({ top: 100, bottom: 600, height: 500 }, { top: 200, bottom: 220, height: 20 });
    assert.equal(scroller.scrollTop, 0);
  });

  it("waits for the menu to open when the sidebar has no height", () => {
    const scroller = run({ top: 0, bottom: 0, height: 0 }, { top: 900, bottom: 920, height: 20 });
    assert.equal(scroller.scrollTop, 0);
    scroller.rect = { top: 100, bottom: 600, height: 500 };
    scroller.listener({ newState: "open" });
    assert.equal(scroller.scrollTop, 560);
  });

  it("does nothing without a current link", () => {
    const scroller = run({ top: 100, bottom: 600, height: 500 }, null, false);
    assert.equal(scroller.scrollTop, 0);
    assert.equal(scroller.listener, null);
  });
});
