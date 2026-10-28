// SPDX-License-Identifier: AGPL-3.0-or-later
// The code browser's syntax colours (web/app/highlight.js): what a line's tokens are, and the state
// carried between lines. A minimal DOM stands in for the browser: spans with a class and text.
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
  className = "";
  readonly style = { setProperty() {} };
  append(...nodes: (FakeNode | string)[]) {
    for (const n of nodes) this.childNodes.push(typeof n === "string" ? new FakeText(n) : n);
  }
  setAttribute() {}
  addEventListener() {}
}
Object.assign(globalThis, {
  Node: FakeNode,
  document: { createElement: () => new FakeElement(), createTextNode: (s: string) => new FakeText(s), addEventListener() {} },
  window: { addEventListener() {} },
});
type Highlighter = { line(text: string): (FakeElement | string)[]; skip(lines: string[]): void; state: unknown };
const { highlighter } = (await import(join(import.meta.dirname, "../packages/host-workerd/web/app/highlight.js"))) as { highlighter: (path: string) => Highlighter };

/** A line's tokens as [class, text] ("" for plain text). */
const tokens = (nodes: (FakeElement | string)[]) => nodes.map((n) => (typeof n === "string" ? ["", n] : [n.className.replace("tk-", ""), (n.childNodes[0] as FakeText).data]));
/** The runs of text with class `cls`. */
const runs = (nodes: (FakeElement | string)[], cls: string) => tokens(nodes).filter(([c]) => c === cls).map(([, t]) => t);

describe("syntax colours", () => {
  test("a regex literal where an expression may start; a division after a value", () => {
    const hl = highlighter("a.ts");
    const line = hl.line('const s = path.replace(/\\/*$/, "") + `/`;');
    assert.deepEqual(runs(line, "str"), ["/\\/*$/", '""', "`/`"]);
    assert.deepEqual(runs(line, "com"), [], "no block comment opened");
    assert.equal(hl.state, null);
    assert.deepEqual(runs(hl.line("const re = /`[/]`/g, half = n / 2 / 1;"), "str"), ["/`[/]`/g"], "a / in a class doesn't close it; divisions stay plain");
    assert.deepEqual(runs(hl.line("  return /^\\d+$/.test(x) ? a / b : c;"), "str"), ["/^\\d+$/"]);
    assert.deepEqual(runs(hl.line("const f = (x) => /a/.test(x);"), "str"), ["/a/"], "after =>");
    assert.equal(hl.state, null);
  });

  test("a keyword after a dot is a member, not a keyword; after a spread it still is one", () => {
    const line = highlighter("a.js").line("map.get(k).type; x?.delete(k); [...new Set(a)]");
    assert.deepEqual(runs(line, "kw"), ["new"]);
    assert.deepEqual(runs(line, "fn"), ["get", "delete", "Set"]);
  });

  test("a hunk starts where the file above it leaves off: inside a comment or a template string", () => {
    const file = ["/**", " * A doc comment", " * that runs on", " */", "const t = `one", "two", "three`;"];
    const above = highlighter("a.ts");
    above.skip(file.slice(0, 2));
    const hunk = highlighter("a.ts");
    hunk.state = above.state;
    assert.deepEqual(tokens(hunk.line(file[2])), [["com", " * that runs on"]]);
    assert.deepEqual(tokens(hunk.line(file[3])), [["com", " */"]]);
    above.skip(file.slice(2, 5));
    hunk.state = above.state;
    assert.deepEqual(tokens(hunk.line(file[5])), [["str", "two"]]);
    assert.deepEqual(tokens(highlighter("a.ts").line(file[5])), [["", "two"]], "unprimed, it reads as code");
  });
});
