// SPDX-License-Identifier: AGPL-3.0-or-later
// The web client's Markdown for the intake's replies (kit.js `markdown`): what it turns into
// elements, and that model output never becomes HTML or a non-web link. A minimal DOM stands in for
// the browser: elements, text nodes and attributes are all `markdown` uses.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

class FakeNode {}
class FakeText extends FakeNode {
  readonly data: string;
  constructor(data: string) {
    super();
    this.data = data;
  }
}
class FakeElement extends FakeNode {
  readonly childNodes: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  className = "";
  readonly style = { setProperty() {} };
  readonly tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
  append(...nodes: (FakeNode | string)[]) {
    for (const n of nodes) this.childNodes.push(typeof n === "string" ? new FakeText(n) : n);
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null;
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, v);
  }
  addEventListener() {}
}
Object.assign(globalThis, {
  Node: FakeNode,
  document: { createElement: (tag: string) => new FakeElement(tag.toUpperCase()), createTextNode: (s: string) => new FakeText(s), addEventListener() {} },
  window: { addEventListener() {} },
});
const { markdown } = (await import(join(import.meta.dirname, "../packages/host-workerd/web/kit.js"))) as { markdown: (text: string) => FakeNode[] };

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (n: FakeNode): string => {
  if (n instanceof FakeText) return escape(n.data);
  const el = n as FakeElement;
  const tag = el.tagName.toLowerCase();
  const attrs = [...el.attrs].map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${tag}${attrs}>${el.childNodes.map(html).join("")}</${tag}>`;
};
const md = (text: string) => markdown(text).map(html).join("");

describe("the intake's Markdown", () => {
  test("paragraphs, line breaks and headings", () => {
    assert.equal(md("one\ntwo\n\nthree"), "<p>one\ntwo</p><p>three</p>");
    assert.equal(md("# Grants\nWho may do what."), "<p><strong>Grants</strong></p><p>Who may do what.</p>");
  });

  test("lists: bullets, numbers from where they start, one level inside an item", () => {
    assert.equal(md("- one\n- **two**"), "<ul><li>one</li><li><strong>two</strong></li></ul>");
    assert.equal(md("3. three\n4. four"), '<ol start="3"><li>three</li><li>four</li></ol>');
    assert.equal(md("1. a\n   - b\n   - c\n2. d"), "<ol><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ol>");
    assert.equal(md("- a\n\n- b"), "<ul><li>a</li><li>b</li></ul>", "a blank line between items keeps one list");
  });

  test("code: blocks and spans keep what's in them as written", () => {
    assert.equal(md("```js\nconst a = '<b>**x**</b>';\n```"), "<pre><code>const a = '&lt;b&gt;**x**&lt;/b&gt;';</code></pre>");
    assert.equal(md("run `hewn **open**`"), "<p>run <code>hewn **open**</code></p>");
    assert.equal(md("**`a**b` here**"), "<p><strong><code>a**b</code> here</strong></p>", "code inside bold stays whole");
    assert.equal(md("*so* and snake_case_id"), "<p><em>so</em> and snake_case_id</p>");
  });

  test("links: web links only, brackets in a url kept", () => {
    assert.equal(md("[docs](https://hewn.tools/docs)"), '<p><a href="https://hewn.tools/docs" target="_blank" rel="noopener noreferrer">docs</a></p>');
    assert.equal(md("[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) after"), '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer">Foo</a> after</p>');
    assert.equal(md("[click](javascript:alert(1))"), "<p>click</p>", "not a web link: just its label");
    assert.equal(md("[page](docs/concepts.md)"), "<p>page</p>");
  });

  test("HTML in a reply is text", () => {
    assert.equal(md('<img src=x onerror="alert(1)">'), '<p>&lt;img src=x onerror="alert(1)"&gt;</p>');
  });
});
