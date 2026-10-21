// SPDX-License-Identifier: Apache-2.0
// Injected by the platform into every capability UI page (served at /_platform/session.js).
// A UI lives at <hewn>/tools/<id>/~<key>/ in a sandbox with an opaque origin of its own (no cookies, no
// storage), so it authenticates with a session token instead. The token arrives in the URL
// fragment (never sent to servers or logs), is kept for the tab in window.name (it survives a
// reload; browsers clear it when the tab goes to another site), and is attached to the UI's own
// API requests. Existing `fetch("/api/invoke")` code just works: the shim sends it to this UI's
// API (<hewn>/tools/<id>/~<key>/api/invoke).
(() => {
  // /tools/<id>/~<key>/: the UI key is part of the base.
  const base = /^\/tools\/[a-z0-9][a-z0-9-]*\/(?:~[A-Za-z0-9_-]+\/)?/.exec(location.pathname)?.[0] ?? "/";
  const NAME = `hewn_session:${base}:`;
  let memory = null;
  const m = /(?:^#|&)hewn_session=([^&]+)/.exec(location.hash);
  if (m) {
    memory = decodeURIComponent(m[1]);
    window.name = NAME + memory;
    // A widget's tap opens the UI at a section (`ui#today`): the page sees that as its fragment.
    const section = /&section=([A-Za-z0-9_-]{1,40})(?:&|$)/.exec(location.hash)?.[1];
    history.replaceState(null, "", location.pathname + location.search + (section ? `#${section}` : ""));
  } else if (window.name.startsWith(NAME)) {
    memory = window.name.slice(NAME.length);
  }

  // window.name outlives the page within this frame: a page on another site loaded here could
  // read the token. Links and forms to other sites open in a new tab (which starts with no name);
  // where the browser says where a navigation goes, the token is dropped before leaving.
  const elsewhere = (href) => {
    try {
      return new URL(href, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  };
  addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href], area[href]") : null;
    if (a && elsewhere(a.href)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
  }, true);
  addEventListener("submit", (e) => {
    const form = e.target;
    if (form instanceof HTMLFormElement && elsewhere(form.action)) form.target = "_blank";
  }, true);
  window.navigation?.addEventListener("navigate", (e) => {
    if (elsewhere(e.destination.url) && window.name.startsWith(NAME)) window.name = "";
  });

  // The UI's API: absolute (/api/…) and relative (api/…) paths both go to <base>api/….
  const apiUrl = (url) => {
    if (url.origin !== location.origin) return undefined;
    if (url.pathname.startsWith(base + "api/")) return url;
    if (url.pathname.startsWith("/api/")) return new URL(base + url.pathname.slice(1) + url.search, location.href);
    return undefined;
  };
  const nativeFetch = window.fetch.bind(window);
  // Embedded: a failed operation is worth a word to the web client, which offers to have it fixed
  // (it reads what failed from Hewn itself; nothing about the call crosses here).
  const failed = (res, api) => {
    if (!res.ok && window.top !== window.self && api.pathname.endsWith("/api/invoke")) window.parent.postMessage({ hewn: 1, type: "failed" }, "*");
    return res;
  };
  window.fetch = (input, init = {}) => {
    const api = apiUrl(new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href));
    if (api && memory) {
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("authorization", `Hewn ${memory}`);
      headers.set("x-hewn-ui", "1");
      if (!(input instanceof Request)) return nativeFetch(api, { ...init, headers }).then((res) => failed(res, api));
      const r = new Request(input, init);
      return (r.method === "GET" || r.method === "HEAD" ? Promise.resolve(undefined) : r.arrayBuffer()).then((body) => nativeFetch(api, { method: r.method, headers, body, signal: r.signal })).then((res) => failed(res, api));
    }
    return nativeFetch(input, init);
  };

  // Embedded in the Hewn web client: tell it the page's title, theme colour and scroll position
  // (for its bar, and to come back to the same place), and accept a scroll position to restore.
  // Nothing else crosses: the frame is sandboxed, on an opaque origin.
  if (window.top !== window.self) {
    const post = (msg) => window.parent.postMessage({ hewn: 1, ...msg }, "*");
    const meta = () => post({ type: "meta", title: document.title.slice(0, 80), themeColor: document.querySelector('meta[name="theme-color"]')?.content?.slice(0, 40) ?? null });
    let pending = 0;
    addEventListener("scroll", () => {
      clearTimeout(pending);
      pending = setTimeout(() => post({ type: "scroll", y: Math.round(scrollY) }), 150);
    }, { passive: true });
    addEventListener("message", (e) => {
      if (e.source !== window.parent || e.data?.hewn !== 1 || e.data.type !== "restore-scroll") return;
      const y = Number(e.data.y) || 0;
      // Content may still be rendering from API calls: try a few times.
      [0, 200, 600, 1200].forEach((ms) => setTimeout(() => scrollY < y && scrollTo(0, y), ms));
    });
    addEventListener("load", () => (meta(), post({ type: "ready" })));
    new MutationObserver(meta).observe(document.querySelector("title") ?? document.head, { childList: true, subtree: true, characterData: true });
  }

  /** Convenience for capability UIs: hewn.call("op", input) → { result } | { error, message }. */
  window.hewn = {
    call: (operation, input = {}) =>
      fetch("/api/invoke", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }) }).then((r) => r.json()),
    manifest: () => fetch("/api/manifest").then((r) => r.json()),
    embedded: window.top !== window.self,
  };
})();
