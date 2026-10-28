// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";

const SHIM = readFileSync(resolve(import.meta.dirname, "../packages/ui/src/session.js"), "utf8");

/** Just enough of a browser frame for the shim: listeners, location, window.name, Navigation API; `embedded`: in the web client. */
function frame(hash: string, { embedded = false } = {}) {
  class Element {
    href = "";
    target = "";
    rel = "";
    closest() {
      return this;
    }
  }
  class HTMLFormElement extends Element {}
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const nav: ((e: any) => void)[] = [];
  const url = new URL(`http://hewn.localhost:7717/tools/reading-log/~k3y/${hash}`);
  const win: any = {
    name: "",
    location: { href: url.href, origin: url.origin, pathname: url.pathname, search: "", hash: url.hash },
    history: { replaceState() {} },
    fetch: async () => new Response(),
    addEventListener: (t: string, fn: (e: any) => void) => (listeners[t] ??= []).push(fn),
    navigation: { addEventListener: (_t: string, fn: (e: any) => void) => nav.push(fn) },
    document: { documentElement: { dataset: {} as Record<string, string> }, querySelector: () => null, head: {} },
    MutationObserver: class {
      observe() {}
    },
    Element,
    HTMLFormElement,
    URL,
    Headers,
    Request,
  };
  win.window = win;
  win.top = win.self = win;
  if (embedded) (win.top = {}), (win.parent = { postMessage() {} });
  runInNewContext(SHIM, win);
  return {
    win,
    theme: () => win.document.documentElement.dataset.theme,
    message: (data: unknown, source = win.parent) => (listeners.message ?? []).forEach((fn) => fn({ source, data })),
    click: (href: string) => {
      const a = Object.assign(new Element(), { href: new URL(href, url).href });
      for (const fn of listeners.click ?? []) fn({ target: a });
      return a;
    },
    navigate: (to: string) => nav.forEach((fn) => fn({ destination: { url: new URL(to, url).href } })),
  };
}

describe("UI session shim: the token stays in the frame", () => {
  test("links to other sites open in a new tab without an opener; own links stay", () => {
    const f = frame("#hewn_session=tok123");
    assert.match(f.win.name, /tok123$/);
    const out = f.click("https://books.example/isbn/1");
    assert.equal(out.target, "_blank");
    assert.equal(out.rel, "noopener noreferrer");
    const own = f.click("/tools/reading-log/~k3y/book/1");
    assert.equal(own.target, "");
  });

  test("a navigation to another site drops the token first; a reload keeps it", () => {
    const f = frame("#hewn_session=tok123");
    f.navigate("/tools/reading-log/~k3y/");
    assert.match(f.win.name, /tok123$/);
    f.navigate("https://evil.example/");
    assert.equal(f.win.name, "");
  });
});

describe("UI session shim: the owner's light or dark", () => {
  test("from the fragment onto <html> (where ui.css reads it); none, or not light or dark: the browser's", () => {
    assert.equal(frame("#hewn_session=tok&theme=light").theme(), "light");
    assert.equal(frame("#hewn_session=tok&section=today&theme=dark").theme(), "dark");
    assert.equal(frame("#hewn_session=tok").theme(), undefined);
    assert.equal(frame("#hewn_session=tok&theme=sepia").theme(), undefined);
  });

  test("in the web client, a change comes by message from it alone; system goes back to the browser's", () => {
    const f = frame("#hewn_session=tok&theme=dark", { embedded: true });
    f.message({ hewn: 1, type: "theme", theme: "light" });
    assert.equal(f.theme(), "light");
    f.message({ hewn: 1, type: "theme", theme: "dark" }, {});
    assert.equal(f.theme(), "light", "another window's message is ignored");
    f.message({ hewn: 1, type: "theme", theme: "system" });
    assert.equal(f.theme(), undefined);
  });
});
