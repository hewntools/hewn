// SPDX-License-Identifier: AGPL-3.0-or-later
// The model port on the real workerd host: ctx.model crosses Durable Object RPC into the isolate.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { FIXTURES } from "./helpers.ts";
import { signedIn, startTestHost, type TestHost } from "./workerd-helpers.ts";

describe("model port on the workerd host", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost();
  });
  after(() => h?.stop());

  test("validation's fake replies reach the isolate's ctx.model (text, JSON, images, errors)", async () => {
    const r = await h.sv.admin("install", { name: "Word Explainer", purpose: "words", dir: join(FIXTURES, "word-explainer"), wait: true });
    assert.equal(r.status, "promoted", JSON.stringify(r.log));
    const st = (await h.sv.admin("call", { method: "readiness", args: ["word-explainer"] })).result;
    assert.deepEqual(st.pendingGrants, ["model:light"]);
    assert.match(st.missingModel, /no model provider is set up/);
  });

  test("code without requires.model has no ctx.model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-no-model-"));
    try {
      cpSync(join(FIXTURES, "word-explainer"), dir, { recursive: true });
      const m = JSON.parse(readFileSync(join(dir, "capability.json"), "utf8"));
      m.id = "no-model";
      m.name = "No Model";
      delete m.requires;
      // Only the probe: the rest call the model without asking for it, a crash Hewn's schema fuzz finds.
      m.operations = m.operations.filter((o: { name: string }) => o.name === "probe");
      writeFileSync(join(dir, "capability.json"), JSON.stringify(m));
      writeFileSync(join(dir, "tests/cases.json"), JSON.stringify([{ name: "no model", operation: "probe", input: {}, expect: { hasModel: false } }]));
      const r = await h.sv.admin("install", { name: "No Model", purpose: "p", dir, wait: true });
      assert.equal(r.status, "promoted", JSON.stringify(r.log));
      assert.deepEqual((await h.invoke("no-model", "probe")).result, { hasModel: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hosted: tools' model calls go to the host, through the supervisor", () => {
  let h: TestHost;
  let service: Server;
  const asked: any[] = [];
  /** What the service answers on /v1/allowance (its status and body), and who asked. */
  let allowance: { status: number; body: unknown } = { status: 404, body: {} };
  const allowanceAsked: (string | undefined)[] = [];
  before(async () => {
    // The host's build service: its model list (with what each tier runs on) and /v1/generate.
    service = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      if (req.url === "/v1/allowance") {
        allowanceAsked.push(req.headers.authorization);
        return void res.writeHead(allowance.status, { "content-type": "application/json" }).end(JSON.stringify(allowance.body));
      }
      if (req.url === "/v1/models") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [], tiers: { light: "Haiku 5.5" } }));
      if (req.url === "/v1/generate") {
        const body = JSON.parse(raw);
        asked.push({ auth: req.headers.authorization, body });
        if (String(body.messages[0].content).includes("spent")) return void res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ refused: "This Hewn has used this month's 800 Credits." }));
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: JSON.stringify({ explanation: "Pleased." }), usage: { inputTokens: 900, outputTokens: 80 }, model: "claude-haiku-5-5", charge: { amount: 0.37, unit: "Credits" } }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => service.listen(0, "127.0.0.1", () => r()));
    h = await startTestHost({ remote: { url: `http://127.0.0.1:${(service.address() as AddressInfo).port}/`, token: "host-token", label: "Test Cloud" }, hosted: {} });
  });
  after(async () => {
    // Also when the host didn't start: an open server would keep the test process from exiting.
    await h?.stop();
    await new Promise((r) => service.close(r));
  });

  test("no key needed; the call reaches the host with its token; the charge counts; a refusal is the host's words", async () => {
    const r = await h.sv.admin("install", { name: "Word Explainer", purpose: "words", dir: join(FIXTURES, "word-explainer"), wait: true });
    assert.equal(r.status, "promoted", JSON.stringify(r.log));
    let st = (await h.sv.admin("call", { method: "readiness", args: ["word-explainer"] })).result;
    assert.equal(st.missingModel, undefined, "no provider or key when the host runs model calls");
    await h.sv.admin("call", { method: "approveGrants", args: ["word-explainer"] });
    st = (await h.sv.admin("call", { method: "readiness", args: ["word-explainer"] })).result;
    assert.equal(st.ready, true);
    const out = await h.invoke("word-explainer", "explain", { word: "gruntled" });
    assert.equal(out.result.explanation, "Pleased.");
    assert.equal(asked.at(-1).auth, "Bearer host-token", "the supervisor holds the token, not the isolate");
    assert.equal(asked.at(-1).body.tier, "light");
    assert.deepEqual((await h.sv.admin("call", { method: "models", args: [] })).result.host.charges.totals, [{ unit: "Credits", amount: 0.37 }]);
    await assert.rejects(h.invoke("word-explainer", "explain", { word: "spent" }), /800 Credits/);
  });

  test("the allowance: from the service to the web client and the Inbox, a 404 is today's view, a failure keeps the last answer", async () => {
    const web = await signedIn(h);
    const stated = { unit: "Credits", used: 1700, of: 2000, resetsAt: "2026-12-01T00:00:00Z", perBuild: 250, more: "https://example.com/more" };
    allowance = { status: 200, body: { allowance: stated, extra: true } };
    const m = await web("/api/models?fresh=1");
    assert.deepEqual(m.host.allowance, { ...stated, resetsAt: "2026-12-01T00:00:00.000Z" });
    assert.equal(allowanceAsked.at(-1), "Bearer host-token", "with the builder's token, from the supervisor");
    const notice = (await web("/api/inbox")).needs.find((n: { id: string }) => n.id === "allowance");
    assert.equal(notice?.severity, "warn");
    assert.match(notice.detail, /^85% of 2000 used · they renew on (30 Nov|1 Dec)$/);
    // The service fails after a good answer: the last one is kept.
    allowance = { status: 500, body: { error: "down" } };
    assert.equal((await web("/api/models?fresh=1")).host.allowance.used, 1700);
    // It offers none: today's view, the charges as before.
    allowance = { status: 404, body: {} };
    const none = await web("/api/models?fresh=1");
    assert.equal(none.host.allowance, null);
    assert.ok(Array.isArray(none.host.charges.totals));
    assert.equal((await web("/api/inbox")).needs.some((n: { id: string }) => n.id === "allowance"), false);
  });
});
