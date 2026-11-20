// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gatedFetch } from "@hewntools/host-workerd/egress.ts";

/** A fake network: each URL answers from the table; every request is recorded. */
function net(routes: Record<string, (req: Request) => Response>) {
  const seen: { url: string; method: string; auth: string | null; body: string }[] = [];
  const fetchFn = async (req: Request) => {
    seen.push({ url: req.url, method: req.method, auth: req.headers.get("authorization"), body: req.body ? await req.text() : "" });
    return (routes[req.url] ?? (() => new Response("not found", { status: 404 })))(req);
  };
  return { seen, fetchFn };
}
const redirect = (status: number, location: string) => () => new Response(null, { status, headers: { location } });

describe("egress gate", () => {
  test("a host outside the grant is refused before anything is sent", async () => {
    const n = net({});
    const r = await gatedFetch(new Request("https://evil.example/"), ["api.example.com"], n.fetchFn);
    assert.equal(r.status, 403);
    assert.match(await r.text(), /^egress denied: evil\.example/);
    assert.equal(n.seen.length, 0);
  });

  test("a redirect to a host outside the grant is refused, not followed", async () => {
    const n = net({ "https://api.example.com/go": redirect(302, "https://evil.example/collect?d=secret") });
    const r = await gatedFetch(new Request("https://api.example.com/go"), ["api.example.com"], n.fetchFn);
    assert.equal(r.status, 403);
    assert.match(await r.text(), /egress denied: evil\.example/);
    assert.deepEqual(n.seen.map((s) => s.url), ["https://api.example.com/go"]);
  });

  test("redirects within the grant are followed; credentials don't cross origins; 303 becomes GET", async () => {
    const n = net({
      "https://api.example.com/a": redirect(307, "/b"),
      "https://api.example.com/b": redirect(303, "https://cdn.example.com/c"),
      "https://cdn.example.com/c": () => new Response("done"),
    });
    const r = await gatedFetch(new Request("https://api.example.com/a", { method: "POST", body: "payload", headers: { authorization: "Bearer t" } }), ["api.example.com", "*.example.com"], n.fetchFn);
    assert.equal(await r.text(), "done");
    assert.deepEqual(n.seen, [
      { url: "https://api.example.com/a", method: "POST", auth: "Bearer t", body: "payload" },
      { url: "https://api.example.com/b", method: "POST", auth: "Bearer t", body: "payload" },
      { url: "https://cdn.example.com/c", method: "GET", auth: null, body: "" },
    ]);
  });

  test("HEWN_NETWORK=off: nothing goes out, not even to an approved host", async () => {
    const n = net({ "https://api.example.com/a": () => new Response("ok") });
    const r = await gatedFetch(new Request("https://api.example.com/a"), ["api.example.com"], n.fetchFn, "off");
    assert.equal(r.status, 403);
    assert.match(await r.text(), /^egress denied: the network is off/);
    assert.equal(n.seen.length, 0);
  });

  test("HEWN_NETWORK=get: GET and HEAD go to approved hosts; a POST, PUT or DELETE is refused before anything is sent", async () => {
    const n = net({ "https://api.example.com/a": () => new Response("ok") });
    assert.equal(await (await gatedFetch(new Request("https://api.example.com/a"), ["api.example.com"], n.fetchFn, "get")).text(), "ok");
    assert.equal((await gatedFetch(new Request("https://api.example.com/a", { method: "HEAD" }), ["api.example.com"], n.fetchFn, "get")).status, 200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await gatedFetch(new Request("https://api.example.com/a", { method, body: "payload" }), ["api.example.com"], n.fetchFn, "get");
      assert.equal(r.status, 403, method);
      assert.match(await r.text(), new RegExp(`^egress denied: only GET and HEAD go out .* a ${method} to api\\.example\\.com`));
    }
    assert.deepEqual(n.seen.map((s) => s.method), ["GET", "HEAD"]);
    // A GET that would become a WebSocket (a channel both ways) is refused too.
    const ws = await gatedFetch(new Request("https://api.example.com/a", { headers: { upgrade: "websocket" } }), ["api.example.com"], n.fetchFn, "get");
    assert.equal(ws.status, 403);
    assert.match(await ws.text(), /an upgrade to websocket at api\.example\.com wasn't sent/);
    assert.equal(n.seen.length, 2);
    // An unapproved host is still refused.
    assert.equal((await gatedFetch(new Request("https://evil.example/"), ["api.example.com"], n.fetchFn, "get")).status, 403);
    assert.equal(n.seen.length, 2);
  });

  test("redirect: manual hands the redirect back; loops stop", async () => {
    const n = net({ "https://api.example.com/loop": redirect(302, "/loop") });
    const manual = await gatedFetch(new Request("https://api.example.com/loop", { redirect: "manual" }), ["api.example.com"], n.fetchFn);
    assert.equal(manual.status, 302);
    const looped = await gatedFetch(new Request("https://api.example.com/loop"), ["api.example.com"], n.fetchFn);
    assert.equal(looped.status, 508);
  });

  test("each refused host is told before the refusal is answered: outside the grant, a redirect's, with the network off or GET only; an allowed one isn't", async () => {
    const n = net({ "https://api.example.com/go": redirect(302, "https://evil.example/c"), "https://api.example.com/ok": () => new Response("ok") });
    const told: string[] = [];
    const refused = async (host: string) => {
      await new Promise((r) => setTimeout(r, 5));
      told.push(host);
    };
    const ask = async (url: string, init: RequestInit = {}, network?: "off" | "get") => {
      const before = told.length;
      const r = await gatedFetch(new Request(url, init), ["api.example.com"], n.fetchFn, network, refused);
      return { status: r.status, told: told.slice(before) };
    };
    assert.deepEqual(await ask("https://other.example/a"), { status: 403, told: ["other.example"] });
    assert.deepEqual(await ask("https://api.example.com/go"), { status: 403, told: ["evil.example"] });
    assert.deepEqual(await ask("https://api.example.com/ok", {}, "off"), { status: 403, told: ["api.example.com"] });
    assert.deepEqual(await ask("https://api.example.com/ok", { method: "POST", body: "x" }, "get"), { status: 403, told: ["api.example.com"] });
    assert.deepEqual(await ask("https://api.example.com/ok"), { status: 200, told: [] });
  });
});
