// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings on the real workerd host with the host's builder (HEWN_BUILD_URL): it is the default,
// saving another setting doesn't store the defaults, and a builder stored that way is repaired on start.
import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, test } from "node:test";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

describe("settings with the host's builder", () => {
  let h: TestHost;
  const settings = (change?: Record<string, unknown>) => h.sv.admin("settings", change);
  before(async () => {
    h = await startTestHost({ remote: { url: "http://127.0.0.1:9/", token: "t", label: "Test Cloud" } });
  });
  after(() => h?.stop());

  test("the host's builder and intake are the default, also after saving another setting", async () => {
    assert.equal((await settings()).builder, "remote");
    assert.equal((await settings({ timeZone: "Europe/Stockholm" })).builder, "remote");
    const s = await settings();
    assert.deepEqual([s.builder, s.intake, s.timeZone], ["remote", "remote", "Europe/Stockholm"]);
  });

  test("a builder the owner didn't choose (stored by 0.4.2) is dropped on start; a chosen one stays", async () => {
    await settings({ builder: "claude", intake: "claude" });
    await h.sv.restart();
    let s = await settings();
    assert.deepEqual([s.builder, s.intake], ["remote", "remote"]);
    await settings({ builder: "claude", intake: "claude", jobsChosen: ["builder", "intake"] });
    await h.sv.restart();
    s = await settings();
    assert.deepEqual([s.builder, s.intake], ["claude", "claude"]);
  });
});

describe("hosted mode on the workerd host", () => {
  let h: TestHost;
  const SIGN_IN = "https://host.example/open";
  before(async () => {
    h = await startTestHost({ remote: { url: "http://127.0.0.1:9/", token: "t", label: "Test Cloud" }, hosted: { signInUrl: SIGN_IN } });
  });
  after(() => h?.stop());

  test("signed out: the host's sign-in link; signed in: settings say hosted, no local agents to connect", async () => {
    // As the browser asks (fetch can't set Host): the web client is on hewn.localhost.
    const get = (path: string, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((res, rej) => {
        const r = request({ host: "127.0.0.1", port: h.port, path, headers: { host: `hewn.localhost:${h.port}`, ...headers } }, (m) => {
          let body = "";
          m.on("data", (d) => (body += d));
          m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
        });
        r.on("error", rej);
        r.end();
      });
    const out = await get("/");
    assert.equal(out.status, 401);
    assert.match(out.body, new RegExp(`href="${SIGN_IN}"`));
    assert.doesNotMatch(out.body, /hewn open|terminal/);
    const { ticket } = await h.sv.admin("web-ticket", {});
    const cookie = String([(await get(`/auth?ticket=${ticket}`)).headers["set-cookie"]].flat()[0]).split(";")[0];
    const api = (path: string) => get(`/api${path}`, { cookie, "x-hewn-ui": "1" });
    const s = JSON.parse((await api("/settings")).body);
    assert.equal(s.hosted, true);
    assert.equal(s.builder, "remote");
    assert.equal((await api("/setup/agents")).status, 404);
    assert.deepEqual(JSON.parse((await api("/tools")).body).map((t: { name: string }) => t.name), ["remote"]);
    // The host builds: another builder can't be chosen, and one stored before doesn't count.
    await assert.rejects(h.sv.admin("settings", { builder: "claude", intake: "claude" }), /the host builds tools here/);
    assert.deepEqual([s.builder, s.intake], ["remote", "remote"]);
  });
});
