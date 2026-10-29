// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import { handleUi } from "@hewntools/host-workerd/surface/ui.ts";

const SHIM = readFileSync(resolve(import.meta.dirname, "../packages/ui/src/session.js"), "utf8");

/**
 * Just enough of a browser frame for the shim: listeners, location, history, window.name,
 * Navigation API; `embedded`: in the web client; `own`: a data-theme the page has itself.
 */
function frame(hash: string, { embedded = false, own = "" } = {}) {
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
  let address = url.pathname + url.hash;
  const win: any = {
    name: "",
    location: { href: url.href, origin: url.origin, pathname: url.pathname, search: "", hash: url.hash },
    history: { replaceState: (_s: unknown, _t: string, to: string) => (address = to) },
    fetch: async () => new Response(),
    addEventListener: (t: string, fn: (e: any) => void) => (listeners[t] ??= []).push(fn),
    navigation: { addEventListener: (_t: string, fn: (e: any) => void) => nav.push(fn) },
    document: { documentElement: { dataset: (own ? { theme: own } : {}) as Record<string, string>, style: { colorScheme: "" } }, querySelector: () => null, head: {} },
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
    address: () => address,
    theme: () => win.document.documentElement.dataset.theme,
    colorScheme: () => win.document.documentElement.style.colorScheme,
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

/** The fragment /auth sends the page to, for the web client's way in with this query after the ticket. */
async function fromAuth(query = "") {
  const platform = { redeemUiTicket: () => "tok", uiKey: () => "k3y" } as any;
  const site = { web: "http://hewn.localhost:7717", ui: (id: string) => `http://hewn.localhost:7717/tools/${id}` } as any;
  const r = await handleUi(platform, {} as any, site, "reading-log", "/auth", new Request(`http://hewn.localhost:7717/tools/reading-log/auth?ticket=t1&${query}`));
  const to = new URL(/url=([^"]+)"/.exec(await r.text())![1]);
  assert.equal(to.pathname, "/tools/reading-log/~k3y/");
  return to.hash;
}

describe("UI session shim: the owner's light or dark", () => {
  test("from /auth onto <html>: data-theme for ui.css, color-scheme for light-dark(); none, or not light or dark: the browser's", async () => {
    const f = frame(await fromAuth("theme=light"));
    assert.equal(f.theme(), "light");
    assert.equal(f.colorScheme(), "light");
    assert.equal(frame(await fromAuth("section=today&theme=dark")).theme(), "dark");
    for (const hash of [await fromAuth(), await fromAuth("theme=sepia"), "#hewn_session=tok&theme=sepia", "#theme=dark"]) {
      const g = frame(hash);
      assert.equal(g.theme(), undefined, hash);
      assert.equal(g.colorScheme(), "", hash);
    }
  });

  test("the address keeps the section, never the theme", async () => {
    assert.equal(frame(await fromAuth("section=today&theme=dark")).address(), "/tools/reading-log/~k3y/#today");
    assert.equal(frame(await fromAuth("theme=light")).address(), "/tools/reading-log/~k3y/");
  });

  test("in the web client, a change comes by message from it alone; system goes back to the browser's", async () => {
    const f = frame(await fromAuth("theme=dark"), { embedded: true });
    f.message({ hewn: 1, type: "theme", theme: "light" });
    assert.equal(f.theme(), "light");
    assert.equal(f.colorScheme(), "light");
    f.message({ hewn: 1, type: "theme", theme: "dark" }, {});
    assert.equal(f.theme(), "light", "another window's message is ignored");
    f.message({ hewn: 1, type: "theme", theme: "system" });
    assert.equal(f.theme(), undefined);
    assert.equal(f.colorScheme(), "");
  });

  test("a data-theme the page has of its own stays: System doesn't take it off, Light or Dark doesn't replace it", async () => {
    // In its markup, before the shim runs.
    const f = frame(await fromAuth("theme=light"), { embedded: true, own: "dark" });
    assert.equal(f.theme(), "dark");
    assert.equal(f.colorScheme(), "");
    f.message({ hewn: 1, type: "theme", theme: "system" });
    assert.equal(f.theme(), "dark");
    // From its own script, after (every "ready" brings the web client's again).
    const g = frame(await fromAuth(), { embedded: true });
    g.win.document.documentElement.dataset.theme = "dark";
    g.message({ hewn: 1, type: "theme", theme: "system" });
    assert.equal(g.theme(), "dark");
    g.message({ hewn: 1, type: "theme", theme: "light" });
    assert.equal(g.theme(), "dark");
    // Over the web client's: its color-scheme goes with it.
    const h = frame(await fromAuth("theme=light"), { embedded: true });
    h.win.document.documentElement.dataset.theme = "dark";
    h.message({ hewn: 1, type: "theme", theme: "light" });
    assert.equal(h.theme(), "dark");
    assert.equal(h.colorScheme(), "");
  });
});
