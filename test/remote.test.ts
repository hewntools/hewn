// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { readConfig, writeConfig } from "@hewntools/cli/config.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { normalizePublicUrl } from "@hewntools/core/platform.ts";
import { sha256 } from "@hewntools/core/sha256.ts";
import { b64url, fromB64url, verifyAssertion, verifyRegistration } from "@hewntools/core/webauthn.ts";
import { startPublicServer } from "@hewntools/test-host/server.ts";
import { FIXTURES, installFrom, installSeed, serve, setup } from "./helpers.ts";

// ---------- a software authenticator (ES256, like a phone's passkey) ----------

const concat = (...parts: (Uint8Array | number[])[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
};

function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number) => (n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255]);
  if (typeof v === "number") return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (v instanceof Map) return concat(head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  throw new Error("cbor: unsupported");
}

/** WebCrypto signs ECDSA as r || s; authenticators send DER. */
function rawToDer(raw: Uint8Array) {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    b = b.slice(i);
    return b[0] & 0x80 ? concat([2, b.length + 1, 0], b) : concat([2, b.length], b);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return concat([0x30, r.length + s.length], r, s);
}

const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((x) => parseInt(x, 16)));
const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

class FakeAuthenticator {
  id = crypto.getRandomValues(new Uint8Array(16));
  counter = 0;
  flags = 0x05; // user present + verified
  private keys!: CryptoKeyPair;

  static async make() {
    const a = new FakeAuthenticator();
    a.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    return a;
  }

  private counterBytes() {
    const n = this.counter;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }

  async create(o: { challenge: string; rp: { id: string } }, origin: string) {
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    const cose = new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]]);
    const authData = concat(hexBytes(sha256(o.rp.id)), [this.flags | 0x40], this.counterBytes(), new Uint8Array(16), [this.id.length >> 8, this.id.length & 255], this.id, cbor(cose));
    const attestation = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: b64url(this.id), clientDataJSON: b64url(json({ type: "webauthn.create", challenge: o.challenge, origin })), attestationObject: b64url(attestation) };
  }

  async get(challenge: string, rpId: string, origin: string) {
    if (this.counter) this.counter++;
    const clientData = json({ type: "webauthn.get", challenge, origin });
    const authData = concat(hexBytes(sha256(rpId)), [this.flags], this.counterBytes());
    const signed = concat(authData, new Uint8Array(await crypto.subtle.digest("SHA-256", clientData)));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed));
    return { id: b64url(this.id), clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(rawToDer(raw)) };
  }
}

const SITE = { origin: "https://hewn.example.com", rpId: "hewn.example.com" };

describe("passkeys: WebAuthn verification", () => {
  test("a passkey registers, then signs in", async () => {
    const a = await FakeAuthenticator.make();
    const reg = await verifyRegistration(await a.create({ challenge: "c1", rp: { id: SITE.rpId } }, SITE.origin), { ...SITE, challenge: "c1" });
    assert.equal(reg.credentialId, b64url(a.id));
    assert.equal(reg.key.alg, -7);
    const out = await verifyAssertion(await a.get("c2", SITE.rpId, SITE.origin), { ...SITE, challenge: "c2" }, { key: reg.key, signCount: 0 });
    assert.equal(out.signCount, 0);
  });

  test("refused: another origin, another site, another challenge, a bad signature, no user verification", async () => {
    const a = await FakeAuthenticator.make();
    const reg = await verifyRegistration(await a.create({ challenge: "c", rp: { id: SITE.rpId } }, SITE.origin), { ...SITE, challenge: "c" });
    const stored = { key: reg.key, signCount: 0 };
    await assert.rejects(verifyAssertion(await a.get("x", SITE.rpId, "https://evil.example"), { ...SITE, challenge: "x" }, stored), /made for https:\/\/evil\.example/);
    await assert.rejects(verifyAssertion(await a.get("x", "evil.example", SITE.origin), { ...SITE, challenge: "x" }, stored), /another site/);
    await assert.rejects(verifyAssertion(await a.get("x", SITE.rpId, SITE.origin), { ...SITE, challenge: "y" }, stored), /challenge/);
    const forged = await a.get("x", SITE.rpId, SITE.origin);
    const other = await FakeAuthenticator.make();
    forged.signature = (await other.get("x", SITE.rpId, SITE.origin)).signature;
    await assert.rejects(verifyAssertion(forged, { ...SITE, challenge: "x" }, stored), /signature/);
    a.flags = 0x01;
    await assert.rejects(verifyAssertion(await a.get("x", SITE.rpId, SITE.origin), { ...SITE, challenge: "x" }, stored), /user verification/);
    await assert.rejects(verifyRegistration(await a.create({ challenge: "c", rp: { id: SITE.rpId } }, SITE.origin), { ...SITE, challenge: "c" }), /user verification/);
  });

  test("a counter that goes backwards (a cloned authenticator) is refused", async () => {
    const a = await FakeAuthenticator.make();
    a.counter = 5;
    const reg = await verifyRegistration(await a.create({ challenge: "c", rp: { id: SITE.rpId } }, SITE.origin), { ...SITE, challenge: "c" });
    const ok = await verifyAssertion(await a.get("x", SITE.rpId, SITE.origin), { ...SITE, challenge: "x" }, { key: reg.key, signCount: 5 });
    assert.equal(ok.signCount, 6);
    a.counter = 3;
    await assert.rejects(verifyAssertion(await a.get("x", SITE.rpId, SITE.origin), { ...SITE, challenge: "x" }, { key: reg.key, signCount: 6 }), /counter/);
  });
});

describe("the public URL", () => {
  test("https and a domain name only; stored as its origin", () => {
    assert.equal(normalizePublicUrl("https://Hewn.Example.com/"), "https://hewn.example.com");
    assert.equal(normalizePublicUrl("https://hewn.example.com:8443"), "https://hewn.example.com:8443");
    assert.throws(() => normalizePublicUrl("http://hewn.example.com"), /https/);
    assert.throws(() => normalizePublicUrl("https://hewn.example.com/hewn"), /no path/);
    assert.throws(() => normalizePublicUrl("https://203.0.113.4"), /domain name/);
    assert.throws(() => normalizePublicUrl("https://localhost"), /domain name/);
    assert.throws(() => normalizePublicUrl("hewn.example.com"), /look like/);
  });
});

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe("hewn url --listen: the public listener on the network", () => {
  test("an IPv4 address of this machine; off (or loopback) goes back to loopback only", () => {
    const home = openHome(mkdtempSync(join(tmpdir(), "hewn-listen-")));
    assert.equal(writeConfig(home, { publicListen: "192.168.1.50" }).publicListen, "192.168.1.50");
    assert.equal(readConfig(home).publicListen, "192.168.1.50");
    for (const bad of ["hewn.example.com", "192.168.1", "300.1.1.1", "::1", "192.168.1.50:7718"]) assert.throws(() => writeConfig(home, { publicListen: bad }), /IPv4/, bad);
    assert.equal(writeConfig(home, { publicListen: "127.0.0.1" }).publicListen, undefined);
    writeConfig(home, { publicListen: "10.0.0.2" });
    assert.equal(writeConfig(home, { publicListen: null }).publicListen, undefined);
  });
});

describe("remote web access: the public listener on the public URL", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let pub: Server;
  const logs: string[] = [];
  const port = (s: Server) => (s.address() as AddressInfo).port;

  /** A request as the reverse proxy forwards it: the browser's Host, Origin and cookie. */
  const http = (to: Server, path: string, o: { method?: string; host?: string; cookie?: string; origin?: string; body?: unknown } = {}) =>
    new Promise<Res>((res, rej) => {
      const body = o.body !== undefined ? JSON.stringify(o.body) : undefined;
      const r = request(
        {
          host: "127.0.0.1",
          port: port(to),
          path,
          method: o.method ?? (body ? "POST" : "GET"),
          headers: {
            host: o.host ?? "hewn.example.com",
            ...(o.cookie ? { cookie: o.cookie } : {}),
            ...(o.origin ? { origin: o.origin } : {}),
            ...(path.startsWith("/api/") || path.startsWith("/passkey/") ? { "x-hewn-ui": "1" } : {}),
            ...(body ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
          },
        },
        (m) => {
          let text = "";
          m.on("data", (d) => (text += d));
          m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body: text }));
        },
      );
      r.on("error", rej);
      r.end(body);
    });
  const web = (path: string, o: Parameters<typeof http>[2] = {}) => http(pub, path, { origin: "https://hewn.example.com", ...o });
  const cookieOf = (r: Res) => [r.headers["set-cookie"]].flat().find((c) => c?.startsWith("__Host-hewn_web="));
  const session = (setCookie: string) => setCookie.split(";")[0];
  const signInWithLink = async () => session(cookieOf(await web(`/auth?ticket=${t.platform.createWebTicket(USER)}`))!);

  before(async () => {
    t = setup();
    await installSeed(t.platform);
    await installFrom(t.platform, resolve(FIXTURES, "ui-counter"), "UI Counter");
    server = await serve(t.platform, t.home, { log: (l) => void logs.push(l) });
    pub = await startPublicServer(server, 0, (l) => void logs.push(l));
  });
  after(async () => {
    await new Promise((r) => pub.close(r));
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("without a public URL, only MCP and OAuth answer (as for a tunnel)", async () => {
    assert.equal((await web("/")).status, 404);
    assert.equal((await web("/.well-known/oauth-authorization-server")).status, 200);
  });

  test("signed out on the public URL: the sign-in link from the server, no other way in", async () => {
    t.platform.setPublicUrl(USER, "https://hewn.example.com");
    const page = await web("/");
    assert.equal(page.status, 401);
    assert.match(page.body, /hewn open --print/);
    assert.doesNotMatch(page.body, /id="passkey"/, "no passkey button before a passkey exists");
    assert.equal((await web("/api/capabilities")).status, 401);
    assert.equal((await web("/api/passkeys/options", { body: {} })).status, 401, "adding a passkey needs a session");
  });

  test("a sign-in link: a Secure __Host- cookie, then the offer to add a passkey", async () => {
    const r = await web(`/auth?ticket=${t.platform.createWebTicket(USER)}`);
    assert.equal(r.status, 200);
    assert.match(r.body, /url=\/#\/passkey/);
    const c = cookieOf(r)!;
    assert.match(c, /HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=/);
    assert.doesNotMatch(c, /Domain=/i);
    const remote = await web("/api/remote", { cookie: session(c) });
    assert.equal(remote.status, 200);
    const body = JSON.parse(remote.body);
    assert.equal(body.url, "https://hewn.example.com");
    assert.equal(body.here, "public");
    assert.deepEqual(body.records.map((x: { name: string }) => x.name), ["hewn.example.com"], "one name: no wildcard");
    assert.equal((await web("/api/remote", { cookie: session(c).replace("__Host-hewn_web", "hewn_web") })).status, 401, "the local cookie name isn't accepted on the public URL");
  });

  test("the public web client refuses other origins, capability UIs (opaque origins) included", async () => {
    const cookie = await signInWithLink();
    assert.equal((await web("/api/remote", { cookie, origin: "null" })).status, 403, "a capability UI (an opaque origin)");
    assert.equal((await web("/api/remote", { cookie, origin: "https://other.hewn.example.com" })).status, 403);
    assert.equal((await web("/api/remote", { cookie, origin: "http://hewn.example.com" })).status, 403, "not over plain http");
    const page = await web("/", { cookie });
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /frame-src https:\/\/hewn\.example\.com\/tools\/;/);
  });

  test("add a passkey from the device, then sign in with it", async () => {
    const cookie = await signInWithLink();
    const a = await FakeAuthenticator.make();
    const options = JSON.parse((await web("/api/passkeys/options", { cookie, body: {} })).body);
    assert.equal(options.rp.id, "hewn.example.com");
    assert.equal(options.authenticatorSelection.userVerification, "required");
    const response = await a.create(options, "https://hewn.example.com");
    const added = await web("/api/passkeys", { cookie, body: { challenge: options.challenge, response, name: "Test phone" } });
    assert.equal(added.status, 200, added.body);
    assert.equal((await web("/api/passkeys", { cookie, body: { challenge: options.challenge, response, name: "again" } })).status, 401, "a challenge works once");
    const list = JSON.parse((await web("/api/passkeys", { cookie })).body);
    assert.deepEqual(list.map((p: { name: string; works: boolean }) => [p.name, p.works]), [["Test phone", true]]);

    // Signed out: now the page offers the passkey.
    const page = await web("/");
    assert.match(page.body, /id="passkey"/);
    assert.match(page.body, /<script type="module" src="\/passkey.js"><\/script>/);
    assert.equal((await web("/passkey.js")).status, 200, "the sign-in script is public");

    const o = JSON.parse((await web("/passkey/options", { body: {} })).body);
    const signin = await web("/passkey/signin", { body: { challenge: o.challenge, response: await a.get(o.challenge, "hewn.example.com", "https://hewn.example.com") } });
    assert.equal(signin.status, 200, signin.body);
    const fresh = session(cookieOf(signin)!);
    assert.equal((await web("/api/remote", { cookie: fresh })).status, 200);

    // A sign-in made on another origin, and one from another site's page, are refused.
    const o2 = JSON.parse((await web("/passkey/options", { body: {} })).body);
    const phished = await web("/passkey/signin", { body: { challenge: o2.challenge, response: await a.get(o2.challenge, "hewn.example.com", "https://hewn-example.com") } });
    assert.equal(phished.status, 401);
    assert.equal((await web("/passkey/options", { body: {}, origin: "https://evil.example" })).status, 403);
    assert.ok(t.platform.registry.authorityEvents().some((e: any) => e.action === "passkey_added"), "on Activity");
  });

  test("capability UIs under /tools/<id>/ on the public host, sandboxed, framed only by the public web client", async () => {
    const cookie = await signInWithLink();
    const open = JSON.parse((await web("/api/capabilities/ui-counter/open", { cookie, body: {} })).body);
    assert.match(open.url, /^https:\/\/hewn\.example\.com\/tools\/ui-counter\/auth\?ticket=/);
    const ui = await http(pub, `/tools/ui-counter/~${t.platform.uiKey("ui-counter")}/`, { host: "hewn.example.com" });
    assert.equal(ui.status, 200);
    const csp = String(ui.headers["content-security-policy"]);
    assert.match(csp, /^sandbox allow-scripts /);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, /frame-ancestors https:\/\/hewn\.example\.com;/);
    assert.match(csp, /connect-src https:\/\/hewn\.example\.com\/tools\/ui-counter\/;/);
    const auth = await http(pub, new URL(open.url).pathname + new URL(open.url).search, { host: "hewn.example.com" });
    assert.match(auth.body, /#hewn_session=/);
    assert.equal((await http(pub, `/tools/ui-counter/~${t.platform.uiKey("ui-counter")}/`, { host: "ui-counter.hewn.example.com" })).status, 404, "no subdomains");
    assert.equal((await http(pub, "/tools/ui-counter/", { host: "hewn.example.com" })).status, 404, "not without the UI key");
    assert.match(String((await web("/", { cookie })).headers["content-security-policy"]), /frame-src https:\/\/hewn\.example\.com\/tools\/;/);
  });

  test("other hosts on the public listener: MCP and OAuth only; admin never", async () => {
    assert.equal((await http(pub, "/", { host: "abc.trycloudflare.com" })).status, 404);
    assert.equal((await http(pub, "/.well-known/oauth-authorization-server", { host: "abc.trycloudflare.com" })).status, 200);
    const mcp = await http(pub, "/mcp", { body: {} });
    assert.equal(mcp.status, 401);
    assert.match(String(mcp.headers["www-authenticate"]), /https:\/\/hewn\.example\.com\//);
    assert.equal((await http(pub, "/_admin/status")).status, 404);
  });

  test("passkeys are added on the public URL only; locally the sign-in stays hewn open", async () => {
    const local = `hewn.localhost:${port(server)}`;
    const r = await http(server, `/auth?ticket=${t.platform.createWebTicket(USER)}`, { host: local });
    const c = [r.headers["set-cookie"]].flat().find((x) => x?.startsWith("hewn_web="))!;
    assert.doesNotMatch(c, /Secure/);
    assert.match(r.body, /url=\/"/);
    const add = await http(server, "/api/passkeys/options", { host: local, cookie: c.split(";")[0], body: {} });
    assert.equal(add.status, 400);
    assert.match(JSON.parse(add.body).message, /public URL/);
    assert.equal((await http(server, "/passkey/options", { host: local, body: {} })).status, 404);
  });

  test("a new public URL: passkeys for the old host stop working, and the CLI says so", async () => {
    const r = t.platform.setPublicUrl(USER, "https://hewn.example.org");
    assert.equal(r.passkeysElsewhere, 1);
    assert.deepEqual(t.platform.passkeys(USER).map((p) => [p.host, p.works]), [["hewn.example.com", false]]);
    assert.equal((await http(pub, "/", { host: "hewn.example.com" })).status, 404, "the old host is gone");
    assert.doesNotMatch((await http(pub, "/", { host: "hewn.example.org" })).body, /id="passkey"/);
  });
});
