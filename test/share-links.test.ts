// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { MAX_BUNDLE_BYTES, unpackBundle } from "@hewntools/core/bundle.ts";
import { sourceWords } from "@hewntools/core/manifest.ts";
import { sha256 } from "@hewntools/core/sha256.ts";
import { fetchLink, privateHost } from "@hewntools/host-workerd/surface/fetch-link.ts";
import type { TunnelStatus } from "@hewntools/host-workerd/surface/host.ts";
import { RateLimiter, RULES } from "@hewntools/host-workerd/surface/public.ts";
import { startPublicServer, startServer } from "@hewntools/test-host/server.ts";
import { nodeSurfaceHost } from "@hewntools/test-host/surface.ts";
import { installFrom, installSeed, SEED, setup } from "./helpers.ts";

const SAMPLE = JSON.stringify([{ operation: "record_run", input: { distanceKm: 5.2, durationSeconds: 1700, date: "2026-10-01" } }]);

describe("share links: one version, until it expires or is revoked", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("a link serves the version it was made for, counted, never who; Hewn keeps only the token's hash", async () => {
    const { token, link } = await t.platform.createShareLink(USER, "running-log", {});
    assert.match(token, /^[A-Za-z0-9_-]{32}$/, "24 random bytes, base64url");
    assert.equal(link.version, 1);
    assert.equal(link.downloads, 0);
    const days = (Date.parse(link.expiresAt!) - Date.now()) / 86400_000;
    assert.ok(days > 6.99 && days <= 7, `7 days by default, not ${days}`);
    const rows = JSON.stringify(t.platform.registry.db.prepare("SELECT * FROM share_links").all());
    assert.ok(!rows.includes(token), "the token itself is never stored");
    assert.ok(rows.includes(sha256(token)));
    // A newer version doesn't move the link: it needs a new one (and a new check).
    assert.equal((await t.platform.settle((await t.platform.setSample(USER, "running-log", SAMPLE)).buildId)).status, "promoted");
    const { name, bundle } = await t.platform.sharedBundle(token);
    assert.equal(name, "running-log.hewn.zip");
    const { sidecar, files } = unpackBundle(bundle);
    assert.deepEqual(sidecar.tool, { id: "running-log", version: 1, hash: t.platform.registry.getVersion("running-log", 1)!.contentHash });
    assert.ok(files["sample/calls.json"] && files["src/index.ts"]);
    await t.platform.sharedBundle(token);
    assert.equal(t.platform.shareLinks(USER, "running-log")[0].downloads, 2);
    assert.ok(t.platform.registry.lifecycleEvents().some((e) => e.action === "share" && e.detail === "v1 as a link (7 days)"));
    // A link to the newer version is its own link.
    const v2 = await t.platform.createShareLink(USER, "running-log", { version: 2, expires: "1d" });
    assert.equal(unpackBundle((await t.platform.sharedBundle(v2.token)).bundle).sidecar.tool.version, 2);
    assert.deepEqual(t.platform.shareLinks(USER, "running-log").map((l) => l.version), [2, 1], "newest first");
  });

  test("expiry: 1, 7 or 30 days, or never; anything else is refused; an expired link is gone", async () => {
    for (const [expires, days] of [["1d", 1], ["30d", 30]] as const) {
      const { link } = await t.platform.createShareLink(USER, "running-log", { expires });
      assert.ok(Math.abs((Date.parse(link.expiresAt!) - Date.now()) / 86400_000 - days) < 0.01, expires);
    }
    const never = await t.platform.createShareLink(USER, "running-log", { expires: "never" });
    assert.equal(never.link.expiresAt, null);
    assert.ok(t.platform.registry.lifecycleEvents().some((e) => e.detail === "v1 as a link (until revoked)"));
    for (const expires of ["2d", "", "toString", "__proto__"]) await assert.rejects(t.platform.createShareLink(USER, "running-log", { expires }), /expires must be 1d, 7d, 30d, never/, expires);
    t.platform.registry.db.prepare("UPDATE share_links SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), never.link.id);
    await assert.rejects(t.platform.sharedBundle(never.token), (e: any) => e.code === "not_found");
    assert.ok(!t.platform.shareLinks(USER, "running-log").some((l) => l.id === never.link.id));
  });

  test("Revoke: it 404s from then on and leaves the list; revoking it again says it's gone", async () => {
    const a = await t.platform.createShareLink(USER, "running-log", {});
    const b = await t.platform.createShareLink(USER, "running-log", {});
    t.platform.revokeShareLink(USER, "running-log", a.link.id);
    await assert.rejects(t.platform.sharedBundle(a.token), (e: any) => e.code === "not_found");
    assert.ok(await t.platform.sharedBundle(b.token), "the other link still works");
    assert.deepEqual(t.platform.shareLinks(USER, "running-log").map((l) => l.id), [b.link.id]);
    assert.throws(() => t.platform.revokeShareLink(USER, "running-log", a.link.id), /stopped already/);
    assert.ok(t.platform.registry.lifecycleEvents().some((e) => e.action === "share" && e.detail === "link to v1 revoked"));
  });

  test("only the owner makes, lists and revokes links", async () => {
    const { link } = await t.platform.createShareLink(USER, "running-log", {});
    await assert.rejects(t.platform.createShareLink(t.claude, "running-log", {}), /cannot perform owner actions/);
    assert.throws(() => t.platform.shareLinks(t.claude, "running-log"), /cannot perform owner actions/);
    assert.throws(() => t.platform.revokeShareLink(t.claude, "running-log", link.id), /cannot perform owner actions/);
  });

  test("a token that isn't a working link is the same not_found, whatever its shape", async () => {
    for (const token of ["", "short", "a".repeat(32), "../../etc/passwd-aaaaaaaaaaaaaaaaaaaaaaaaa", `${"a".repeat(31)}/`, "a".repeat(65)]) await assert.rejects(t.platform.sharedBundle(token), (e: any) => e.code === "not_found" && e.message === "no such link", token);
  });

  test("deleting a tool stops its links for good (a restore doesn't bring them back); purging removes them", async () => {
    const { token } = await t.platform.createShareLink(USER, "running-log", { expires: "never" });
    t.platform.archive(USER, "running-log");
    await assert.rejects(t.platform.sharedBundle(token), (e: any) => e.code === "not_found");
    t.platform.restore(USER, "running-log");
    await assert.rejects(t.platform.sharedBundle(token), (e: any) => e.code === "not_found");
    assert.deepEqual(t.platform.shareLinks(USER, "running-log"), []);
    t.platform.archive(USER, "running-log");
    await t.platform.purge(USER, "running-log", "running-log");
    assert.deepEqual(t.platform.registry.db.prepare("SELECT * FROM share_links").all(), []);
  });

  test("a version the check blocks gets no link, for the same reason a file isn't made", async () => {
    const other = setup();
    const seed = mkdtempSync(join(tmpdir(), "hewn-seed-"));
    try {
      cpSync(SEED, seed, { recursive: true });
      rmSync(join(seed, "sample"), { recursive: true });
      await installFrom(other.platform, seed);
      await assert.rejects(other.platform.createShareLink(USER, "running-log", {}), /no sample data/);
      assert.deepEqual(other.platform.registry.db.prepare("SELECT * FROM share_links").all(), []);
    } finally {
      other.cleanup();
      rmSync(seed, { recursive: true, force: true });
    }
  });

  test("where a tool came from, in Info's words: a link shows its host", () => {
    assert.equal(sourceWords({ id: "x", version: 1, hash: "a".repeat(64), from: "link", host: "anna.example.com" }, true), "from a link · anna.example.com");
    assert.equal(sourceWords({ id: "x", version: 1, hash: "a".repeat(64), from: "link", host: "anna.example.com" }), "from anna.example.com");
    assert.equal(sourceWords({ id: "x", version: 1, hash: "a".repeat(64), from: "hub" }, true), "from Hewn's tools · Official");
  });
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

describe("share links and install from a link, over HTTP", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let pub: Server;
  let cookie = "";
  const logs: string[] = [];
  let tunnel: TunnelStatus = { kind: null, state: "off", url: null };
  /** What the network answers for install from a link: a URL's response, and which URLs were asked for. */
  const net = new Map<string, () => Response>();
  const asked: string[] = [];
  const stubFetch = (async (input: Request | string | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    asked.push(url);
    const answer = net.get(url);
    if (!answer) throw new Error("getaddrinfo ENOTFOUND");
    return answer();
  }) as typeof fetch;

  const http = (to: Server, path: string, o: { method?: string; host?: string; body?: unknown; api?: boolean; from?: string } = {}) =>
    new Promise<Res>((resolve, reject) => {
      const port = (to.address() as AddressInfo).port;
      const data = o.body === undefined ? undefined : JSON.stringify(o.body);
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: o.method ?? "GET",
          headers: {
            host: o.host ?? `hewn.localhost:${(server.address() as AddressInfo).port}`,
            ...(cookie ? { cookie } : {}),
            ...(o.api ? { "x-hewn-ui": "1" } : {}),
            ...(o.from ? { "x-forwarded-for": o.from } : {}),
            ...(data ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(data)) } : {}),
          },
        },
        (m) => {
          const chunks: Buffer[] = [];
          m.on("data", (d) => chunks.push(d));
          m.on("end", () => resolve({ status: m.statusCode!, headers: m.headers, body: Buffer.concat(chunks) }));
        },
      );
      r.on("error", reject);
      r.end(data);
    });
  const api = async (path: string, o: { method?: string; body?: unknown } = {}) => {
    const r = await http(server, `/api${path}`, { ...o, api: true });
    return { status: r.status, json: r.body.length ? JSON.parse(r.body.toString()) : undefined };
  };

  before(async () => {
    t = setup();
    await installSeed(t.platform);
    server = await startServer(t.platform, 0, (port) => ({ ...nodeSurfaceHost(t.home, { port, log: (l) => void logs.push(l) }), fetch: stubFetch, tunnel: async () => tunnel }));
    pub = await startPublicServer(server, 0, (l) => void logs.push(l), new RateLimiter({ ...RULES, share: { perClient: 20, total: 100, windowMs: 60_000 } }));
    const r = await http(server, `/auth?ticket=${t.platform.createWebTicket(USER)}`);
    cookie = String(r.headers["set-cookie"]).split(";")[0];
  });
  after(async () => {
    await new Promise((r) => pub.close(r));
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("no public address: Share… has no link to offer, and says why", async () => {
    const share = await api("/capabilities/running-log/share");
    assert.equal(share.status, 200);
    assert.equal(share.json.address, null);
    assert.deepEqual(share.json.links, []);
    const made = await api("/capabilities/running-log/links", { method: "POST", body: {} });
    assert.equal(made.status, 409);
    assert.match(made.json.message, /^Links need a public address/);
  });

  test("with one: the link, served on the public listener on any host, robots kept out, the token never logged; Revoke ends it", async () => {
    t.platform.setPublicUrl(USER, "https://hewn.example.com");
    try {
      const made = await api("/capabilities/running-log/links", { method: "POST", body: { version: 1, expires: "never" } });
      assert.equal(made.status, 200, JSON.stringify(made.json));
      const m = /^https:\/\/hewn\.example\.com\/share\/([A-Za-z0-9_-]{32})$/.exec(made.json.url);
      assert.ok(m, made.json.url);
      const token = m[1];
      assert.equal(made.json.link.expiresAt, null);
      assert.ok(!JSON.stringify(made.json.link).includes(token), "the list never carries the token");
      const share = await api("/capabilities/running-log/share");
      assert.equal(share.json.address, "https://hewn.example.com");
      assert.deepEqual(share.json.links.map((l: any) => l.id), [made.json.link.id]);
      // A tunnel's own host, or any other: share links answer on every host the public listener gets.
      for (const host of ["hewn.example.com", "abc.trycloudflare.com"]) {
        const r = await http(pub, `/share/${token}`, { host });
        assert.equal(r.status, 200, host);
        assert.equal(r.headers["content-type"], "application/zip");
        assert.equal(r.headers["x-robots-tag"], "noindex, nofollow");
        assert.equal(r.headers["cache-control"], "no-store");
        assert.equal(r.headers["content-disposition"], 'attachment; filename="running-log.hewn.zip"');
        assert.equal(unpackBundle(new Uint8Array(r.body)).sidecar.tool.id, "running-log");
      }
      // Every answer under /share/ keeps search engines out, a refusal too; and robots.txt says so.
      for (const [path, method, status] of [["/share/nope", "GET", 404], [`/share/${"b".repeat(32)}`, "GET", 404], [`/share/${token}`, "POST", 405], [`/share/${token}/more`, "GET", 404]] as const) {
        const r = await http(pub, path, { method, host: "hewn.example.com" });
        assert.equal(r.status, status, `${method} ${path}`);
        assert.equal(r.headers["x-robots-tag"], "noindex, nofollow", `${method} ${path}`);
      }
      const robots = await http(pub, "/robots.txt", { host: "abc.trycloudflare.com" });
      assert.equal(robots.status, 200);
      assert.equal(robots.body.toString(), "User-agent: *\nDisallow: /share/\n");
      assert.equal((await api("/capabilities/running-log/share")).json.links[0].downloads, 2);
      assert.ok(logs.some((l) => l.includes("/share/…")), logs.join("\n"));
      assert.ok(!logs.some((l) => l.includes(token)), "a link's token never goes in a log");
      // Revoke, and the link is gone.
      assert.equal((await api(`/capabilities/running-log/links/${made.json.link.id}`, { method: "DELETE" })).status, 200);
      assert.equal((await http(pub, `/share/${token}`, { host: "hewn.example.com" })).status, 404);
      assert.equal((await api(`/capabilities/running-log/links/${made.json.link.id}`, { method: "DELETE" })).status, 404);
    } finally {
      t.platform.setPublicUrl(USER, null);
    }
  });

  test("a tunnel that's up is a public address too", async () => {
    tunnel = { kind: "quick", state: "up", url: "https://abc.trycloudflare.com" };
    try {
      const made = await api("/capabilities/running-log/links", { method: "POST", body: { expires: "1d" } });
      assert.equal(made.status, 200);
      assert.match(made.json.url, /^https:\/\/abc\.trycloudflare\.com\/share\/[A-Za-z0-9_-]{32}$/);
      tunnel = { ...tunnel, state: "starting" };
      assert.equal((await api("/capabilities/running-log/share")).json.address, null);
    } finally {
      tunnel = { kind: null, state: "off", url: null };
    }
  });

  test("share links have their own rate limit, and its refusal keeps robots out too", async () => {
    let last: Res | undefined;
    for (let i = 0; i < 25 && last?.status !== 429; i++) last = await http(pub, `/share/${"c".repeat(32)}`, { host: "hewn.example.com" });
    assert.equal(last!.status, 429);
    assert.equal(last!.headers["x-robots-tag"], "noindex, nofollow");
    assert.ok(!logs.some((l) => l.includes("c".repeat(32))), "nor in the rate limit's log line");
  });

  test("the limit is per address and per link: busy addresses don't use it up for everyone, and one link fetched too often waits on its own", async () => {
    const limited = await startPublicServer(server, 0, () => {}, new RateLimiter({ ...RULES, share: { perClient: 4, total: 1000, windowMs: 60_000 }, shareLink: { perClient: 3, total: 1000, windowMs: 60_000 } }));
    try {
      const link = (c: string) => `/share/${c.repeat(32)}`;
      // One link from three addresses: the fourth address waits for that link, not for another.
      for (const from of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) assert.equal((await http(limited, link("d"), { host: "hewn.example.com", from })).status, 404, from);
      assert.equal((await http(limited, link("d"), { host: "hewn.example.com", from: "198.51.100.4" })).status, 429);
      assert.equal((await http(limited, link("e"), { host: "hewn.example.com", from: "198.51.100.4" })).status, 404);
      // One address trying many links waits on its own; another address doesn't.
      for (const c of ["f", "g", "h", "i"]) assert.equal((await http(limited, link(c), { host: "hewn.example.com", from: "198.51.100.5" })).status, 404, c);
      assert.equal((await http(limited, link("j"), { host: "hewn.example.com", from: "198.51.100.5" })).status, 429);
      assert.equal((await http(limited, link("j"), { host: "hewn.example.com", from: "198.51.100.6" })).status, 404);
    } finally {
      await new Promise((r) => limited.close(r));
    }
  });

  test("install from a link: fetched, staged with its host, installed with its source; http and private addresses refused before any fetch", async () => {
    const { bundle } = await t.platform.shareBundle(USER, "running-log");
    net.set("https://friend.example/share/abc", () => new Response(Buffer.from(bundle), { status: 200, headers: { "content-type": "application/zip" } }));
    const staged = await api("/bundles", { method: "POST", body: { url: "https://friend.example/share/abc" } });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    assert.equal(staged.json.from, "link");
    assert.equal(staged.json.host, "friend.example");
    assert.equal(staged.json.summaryBy, null, "your builder reads it, as for a file");
    const done = await t.platform.settle((await api(`/bundles/${staged.json.token}/install`, { method: "POST", body: { name: "Friends Log", sample: true } })).json.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    const info = await api("/capabilities/friends-log");
    assert.equal(info.json.source.from, "link");
    assert.equal(info.json.source.host, "friend.example");
    assert.equal(info.json.origin, "from a link · friend.example");
    asked.length = 0;
    for (const [url, why] of [
      ["http://friend.example/share/abc", /isn't https/],
      ["https://127.0.0.1/x.zip", /an address on this machine or its own network/],
      ["https://user:pw@friend.example/x.zip", /user name or password/],
      ["not a link", /That isn't a link/],
    ] as const) {
      const r = await api("/bundles", { method: "POST", body: { url } });
      assert.equal(r.status, 400, url);
      assert.match(r.json.message, why, url);
      assert.equal(r.json.details.refusal, "link");
    }
    assert.deepEqual(asked, [], "nothing was fetched");
  });

  test("a link that redirects: the file's own host is what Hewn records and shows, with where the link was", async () => {
    const { bundle } = await t.platform.shareBundle(USER, "running-log");
    net.set("https://short.example/abc", () => new Response(null, { status: 302, headers: { location: "https://files.example/plant.hewn.zip" } }));
    net.set("https://files.example/plant.hewn.zip", () => new Response(Buffer.from(bundle), { status: 200 }));
    const staged = await api("/bundles", { method: "POST", body: { url: "https://short.example/abc" } });
    assert.equal(staged.status, 200, JSON.stringify(staged.json));
    assert.equal(staged.json.host, "files.example", "where the file came from");
    assert.equal(staged.json.linkHost, "short.example", "where the link was");
    const done = await t.platform.settle((await api(`/bundles/${staged.json.token}/install`, { method: "POST", body: { name: "Redirected Log" } })).json.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    const info = await api("/capabilities/redirected-log");
    assert.equal(info.json.source.host, "files.example");
    assert.equal(info.json.origin, "from a link · files.example");
    // No redirect: no link host to show.
    net.set("https://files.example/direct.hewn.zip", () => new Response(Buffer.from(bundle), { status: 200 }));
    assert.equal((await api("/bundles", { method: "POST", body: { url: "https://files.example/direct.hewn.zip" } })).json.linkHost, null);
  });
});

describe("fetchLink: what Hewn fetches when it installs from a link", () => {
  const stub = (answers: Record<string, () => Response>) => {
    const asked: string[] = [];
    const f = (async (input: Request | string | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      asked.push(url);
      const a = answers[url];
      if (!a) throw new Error("unexpected fetch");
      return a();
    }) as typeof fetch;
    return { f, asked };
  };
  const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });

  test("names and addresses on this machine or its network are refused, public ones aren't", () => {
    for (const h of ["localhost", "a.localhost", "printer.local", "app.internal", "box.home.arpa", "intranet", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.169.254", "100.64.0.1", "127.0.0.1", "0.0.0.0", "224.0.0.1", "[::1]", "[::]", "[fd00::1]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:a00:1]"]) assert.equal(privateHost(h), true, h);
    for (const h of ["example.com", "hewn.example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "[2606:4700:4700::1111]", "[::ffff:808:808]"]) assert.equal(privateHost(h), false, h);
    // URL parsing turns other spellings of an address into the dotted one first.
    assert.equal(privateHost(new URL("https://0x7f000001/").hostname), true);
    assert.equal(privateHost(new URL("https://[::FFFF:127.0.0.1]/").hostname), true);
  });

  test("every redirect is checked as the first link is: https, public, at most 5", async () => {
    const zip = new Uint8Array([80, 75, 5, 6]);
    const ok = stub({ "https://a.example/x": redirect("/y"), "https://a.example/y": redirect("https://cdn.example/z", 307), "https://cdn.example/z": () => new Response(zip) });
    const got = await fetchLink("https://a.example/x", ok.f);
    assert.deepEqual([...got.bytes], [...zip]);
    assert.equal(got.host, "cdn.example", "where the file came from: the last redirect's host");
    assert.equal(got.linkHost, "a.example", "the link's own host");
    assert.deepEqual(ok.asked, ["https://a.example/x", "https://a.example/y", "https://cdn.example/z"]);
    await assert.rejects(fetchLink("https://a.example/x", stub({ "https://a.example/x": redirect("http://a.example/x") }).f), /redirects to a link that isn't https/);
    const inside = stub({ "https://a.example/x": redirect("https://169.254.169.254/latest/meta-data") });
    await assert.rejects(fetchLink("https://a.example/x", inside.f), /169\.254\.169\.254, an address on this machine/);
    assert.deepEqual(inside.asked, ["https://a.example/x"], "the private address is never asked");
    const loop: Record<string, () => Response> = {};
    for (let i = 0; i < 10; i++) loop[`https://a.example/${i}`] = redirect(`https://a.example/${i + 1}`);
    await assert.rejects(fetchLink("https://a.example/0", stub(loop).f), /redirects more than 5 times/);
  });

  test("5 MB at most, whatever Content-Length says; a missing file says so", async () => {
    let pulls = 0;
    const big = stub({ "https://a.example/big": () => new Response(new ReadableStream({ pull: (c) => void (pulls++, c.enqueue(new Uint8Array(1 << 20))) }), { headers: { "content-length": String(MAX_BUNDLE_BYTES + 1) } }) });
    await assert.rejects(fetchLink("https://a.example/big", big.f), /over 5 MB/);
    assert.ok(pulls <= 1, `refused on its Content-Length, unread (${pulls} pulls)`);
    let sent = 0;
    const endless = stub({
      "https://a.example/endless": () =>
        new Response(
          new ReadableStream({
            pull: (c) => {
              sent += 1 << 20;
              c.enqueue(new Uint8Array(1 << 20));
            },
          }),
        ),
    });
    await assert.rejects(fetchLink("https://a.example/endless", endless.f), /over 5 MB/);
    assert.ok(sent <= MAX_BUNDLE_BYTES + 2 * (1 << 20), `stopped reading at ${sent}`);
    await assert.rejects(fetchLink("https://a.example/gone", stub({ "https://a.example/gone": () => new Response("no", { status: 404 }) }).f), /nothing at that link \(404\): it may have expired or been revoked/);
    await assert.rejects(fetchLink("https://a.example/err", stub({ "https://a.example/err": () => new Response("no", { status: 500 }) }).f), /a\.example answered 500/);
    await assert.rejects(fetchLink("https://nowhere.example/x", stub({}).f), /couldn't reach nowhere\.example/);
  });
});
