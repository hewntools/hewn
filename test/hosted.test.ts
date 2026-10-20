// SPDX-License-Identifier: AGPL-3.0-or-later
// Hosted mode (HEWN_HOSTED): a host runs Hewn for its owner, who has no terminal. Signed-out pages,
// agent approval and the web client send the owner to the host, never to a command.
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { pkceChallenge } from "@hewntools/core/agents.ts";
import { USER } from "@hewntools/core/auth.ts";
import { hostedFromEnv } from "@hewntools/cli/supervisor/index.ts";
import { startPublicServer, startServer } from "@hewntools/test-host/server.ts";
import { nodeSurfaceHost } from "@hewntools/test-host/surface.ts";
import { setup } from "./helpers.ts";

const SIGN_IN = "https://host.example/open";

describe("hosted mode: the environment", () => {
  test("off unless HEWN_HOSTED=1; it needs the host's builder; the sign-in link is https", () => {
    assert.equal(hostedFromEnv({}), undefined);
    assert.equal(hostedFromEnv({ HEWN_HOSTED: "0", HEWN_BUILD_URL: "https://builds.example/" }), undefined);
    assert.deepEqual(hostedFromEnv({ HEWN_HOSTED: "1", HEWN_BUILD_URL: "https://builds.example/" }), {});
    assert.deepEqual(hostedFromEnv({ HEWN_HOSTED: "1", HEWN_BUILD_URL: "https://builds.example/", HEWN_HOST_SIGNIN_URL: SIGN_IN }), { signInUrl: SIGN_IN });
    assert.throws(() => hostedFromEnv({ HEWN_HOSTED: "yes" }), /must be 1 \(or 0, or unset\)/);
    assert.throws(() => hostedFromEnv({ HEWN_HOSTED: "1" }), /needs HEWN_BUILD_URL/);
    assert.throws(() => hostedFromEnv({ HEWN_HOSTED: "1", HEWN_BUILD_URL: "https://builds.example/", HEWN_HOST_SIGNIN_URL: "http://host.example/open" }), /https/);
  });
});

describe("hosted mode: the public web client", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let pub: Server;
  type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
  const http = (path: string, o: { method?: string; cookie?: string; body?: string; type?: string } = {}) =>
    new Promise<Res>((res, rej) => {
      const r = request(
        {
          host: "127.0.0.1",
          port: (pub.address() as AddressInfo).port,
          path,
          method: o.method ?? "GET",
          headers: {
            host: "hewn.example.com",
            origin: "https://hewn.example.com",
            ...(o.cookie ? { cookie: o.cookie } : {}),
            ...(path.startsWith("/api/") ? { "x-hewn-ui": "1" } : {}),
            ...(o.body ? { "content-type": o.type ?? "application/json", "content-length": String(Buffer.byteLength(o.body)) } : {}),
          },
        },
        (m) => {
          let text = "";
          m.on("data", (d) => (text += d));
          m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body: text }));
        },
      );
      r.on("error", rej);
      r.end(o.body);
    });

  before(async () => {
    t = setup();
    server = await startServer(t.platform, 0, (port) => ({ ...nodeSurfaceHost(t.home, { port }), hosted: { signInUrl: SIGN_IN } }));
    pub = await startPublicServer(server, 0, () => {});
    t.platform.setPublicUrl(USER, "https://hewn.example.com");
  });
  after(async () => {
    await new Promise((r) => pub.close(r));
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("signed out: a link to the host's sign-in, no command", async () => {
    const page = await http("/");
    assert.equal(page.status, 401);
    assert.match(page.body, new RegExp(`href="${SIGN_IN}"`));
    assert.doesNotMatch(page.body, /hewn open|terminal|SSH/);
    const expired = await http("/auth?ticket=nope");
    assert.equal(expired.status, 401);
    assert.match(expired.body, /This link has expired[\s\S]*Sign in from your account/);
    assert.doesNotMatch(expired.body, /hewn open|terminal/);
    assert.doesNotMatch((await http("/api/capabilities")).body, /hewn open/);
  });

  test("approving an agent while signed out: sign in, not a terminal command", async () => {
    const page = await http("/approve?code=BCD-F23");
    assert.equal(page.status, 401);
    assert.match(page.body, /Sign in to approve it/);
    assert.doesNotMatch(page.body, /hewn agents/);
  });

  test("an agent's sign-in page links to Hewn to approve", async () => {
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const reg = JSON.parse((await http("/register", { method: "POST", body: JSON.stringify({ client_name: "claude.ai", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).body);
    const q = new URLSearchParams({ client_id: reg.client_id, response_type: "code", redirect_uri: redirect, code_challenge: pkceChallenge("v".repeat(50)), code_challenge_method: "S256", scope: "discover invoke", state: "s" });
    const page = await http(`/authorize?${q}`);
    assert.match(page.body, /href="https:\/\/hewn\.example\.com\/approve\?code=/);
    assert.doesNotMatch(page.body, /hewn agents approve/);
  });

  test("signed in: settings say hosted; there are no local agents to connect", async () => {
    const cookie = [(await http(`/auth?ticket=${t.platform.createWebTicket(USER)}`)).headers["set-cookie"]].flat().find((c) => c?.startsWith("__Host-hewn_web="))!.split(";")[0];
    const settings = JSON.parse((await http("/api/settings", { cookie })).body);
    assert.equal(settings.hosted, true);
    const agents = await http("/api/setup/agents", { cookie });
    assert.equal(agents.status, 404);
    assert.doesNotMatch(agents.body, /hewn setup/);
    assert.match(JSON.parse((await http("/api/setup/manual", { cookie })).body).publicUrl, /^https:\/\/hewn\.example\.com\/mcp$/);
  });
});
