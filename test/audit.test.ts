// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { USER, WEB_USER } from "@hewntools/core/auth.ts";
import { editJson, FIXTURES, installFrom, setup } from "./helpers.ts";

/** ui-counter plus a destructive `reset`. */
function counterWithReset(): string {
  const dir = mkdtempSync(join(tmpdir(), "hewn-reset-"));
  cpSync(join(FIXTURES, "ui-counter"), dir, { recursive: true });
  editJson(join(dir, "capability.json"), (m) => {
    m.operations.push({ name: "reset", description: "Set the count back to 0", version: 1, sideEffect: "destructive", inputSchema: { type: "object", additionalProperties: false, properties: { to: { type: "integer" } } }, outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } });
  });
  writeFileSync(
    join(dir, "src", "index.ts"),
    `import type { DatabaseSync } from "node:sqlite";
type Ctx = { db: DatabaseSync };
const count = (db: DatabaseSync) => (db.prepare("SELECT n FROM counter WHERE id = 1").get() as { n: number }).n;
export const operations = {
  "increment@1": (_: unknown, { db }: Ctx) => (db.prepare("UPDATE counter SET n = n + 1 WHERE id = 1").run(), { count: count(db) }),
  "get@1": (_: unknown, { db }: Ctx) => ({ count: count(db) }),
  "reset@1": (i: { to?: number }, { db }: Ctx) => (db.prepare("UPDATE counter SET n = ? WHERE id = 1").run(i.to ?? 0), { count: count(db) }),
};
`,
  );
  return dir;
}

describe("destructive calls by agents wait for the owner", () => {
  let t: ReturnType<typeof setup>;
  let dir: string;
  before(async () => {
    t = setup();
    t.platform.confirmWaitMs = 300;
    dir = counterWithReset();
    await installFrom(t.platform, dir);
    await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "increment" });
  });
  after(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  const count = async () => ((await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "get" })).result as { count: number }).count;
  const reset = (to?: number) => t.platform.invoke(t.claude, { capabilityId: "ui-counter", operation: "reset", input: to === undefined ? {} : { to } });

  test("the owner (and UIs) aren't asked; agents' writes and reads aren't either", async () => {
    await t.platform.invoke(WEB_USER, { capabilityId: "ui-counter", operation: "reset", input: { to: 5 } });
    assert.equal(await count(), 5);
    await t.platform.invoke(t.claude, { capabilityId: "ui-counter", operation: "increment" });
    assert.equal(await count(), 6);
  });

  test("held: without a decision it returns awaiting_confirmation; nothing ran", async () => {
    await assert.rejects(reset(), (e: any) => e.code === "awaiting_confirmation" && !!e.details.confirmationId);
    assert.equal(await count(), 6);
    const pending = t.platform.confirmations(USER);
    assert.equal(pending.length, 1);
    assert.deepEqual([pending[0].agentId, pending[0].capabilityId, pending[0].operation], ["claude-code", "ui-counter", "reset@1"]);
    // Asking again with the same input doesn't add a second request.
    await assert.rejects(reset(), (e: any) => e.code === "awaiting_confirmation");
    assert.equal(t.platform.confirmations(USER).length, 1);
    assert.throws(() => t.platform.confirmations(t.claude), /owner/);
  });

  test("confirmed while the call waits: it runs, once", async () => {
    t.platform.confirmWaitMs = 5000;
    const call = reset(2);
    await new Promise((r) => setTimeout(r, 50));
    const c = t.platform.confirmations(USER).find((x) => JSON.stringify(x.input) === '{"to":2}')!;
    t.platform.decideConfirmation(WEB_USER, c.id, true);
    assert.equal(((await call).result as { count: number }).count, 2);
    t.platform.confirmWaitMs = 300;
    await assert.rejects(reset(2), (e: any) => e.code === "awaiting_confirmation", "the next identical call needs a new confirmation");
  });

  test("confirmed later: calling again with the same input goes through; a different input doesn't", async () => {
    const c = t.platform.confirmations(USER).find((x) => JSON.stringify(x.input) === "{}")!;
    t.platform.decideConfirmation(WEB_USER, c.id, true);
    await assert.rejects(reset(9), (e: any) => e.code === "awaiting_confirmation");
    assert.equal(((await reset()).result as { count: number }).count, 0);
  });

  test("rejected: reported to the agent once, and nothing ran", async () => {
    const c = t.platform.confirmations(USER).find((x) => JSON.stringify(x.input) === '{"to":9}')!;
    t.platform.decideConfirmation(WEB_USER, c.id, false);
    await assert.rejects(reset(9), /owner rejected/);
    assert.equal(await count(), 0);
  });

  test("every decision is on the authority trail", () => {
    const e = t.platform.registry.authorityEvents().filter((x) => x.action.startsWith("destructive_"));
    assert.deepEqual(e.map((x) => [x.action, x.subject, x.capabilityId, x.detail, x.actor]).reverse(), [
      ["destructive_confirmed", "claude-code", "ui-counter", "reset@1", "web"],
      ["destructive_confirmed", "claude-code", "ui-counter", "reset@1", "web"],
      ["destructive_rejected", "claude-code", "ui-counter", "reset@1", "web"],
    ]);
  });
});

describe("authority trail and log retention", () => {
  let t: ReturnType<typeof setup>;
  before(() => {
    t = setup();
  });
  after(() => t.cleanup());

  test("agents connected, declined, re-scoped and revoked; secrets set and removed", async () => {
    const store = t.platform.agentStore;
    const reg = store.register({ client_name: "Probe Agent", redirect_uris: ["http://127.0.0.1:1/cb"], token_endpoint_auth_method: "none" }) as { client_id: string };
    const start = () => store.startAuthorization({ client_id: reg.client_id, response_type: "code", code_challenge: "x".repeat(43), code_challenge_method: "S256", scope: "discover invoke" }, { via: "tunnel", issuer: "https://j" });
    t.platform.decideAgent(WEB_USER, start().id, { approve: false });
    t.platform.decideAgent(WEB_USER, start().id, { approve: true, scopes: ["discover", "invoke"] });
    t.platform.updateAgent(WEB_USER, "probe-agent", { scopes: ["discover"] });
    t.platform.updateAgent(WEB_USER, "probe-agent", "revoke");
    await installFrom(t.platform, join(FIXTURES, "secret-echo"));
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "x");
    t.platform.deleteSecret(WEB_USER, "secret-echo", "API_TOKEN");
    const events = t.platform.registry.authorityEvents().reverse().map((e) => [e.action, e.subject, e.actor, e.detail]);
    assert.deepEqual(events, [
      ["agent_declined", "Probe Agent", "web", ""],
      ["agent_connected", "probe-agent", "web", "discover invoke · via tunnel"],
      ["agent_scopes", "probe-agent", "web", "discover"],
      ["agent_revoked", "probe-agent", "web", ""],
      ["secret_set", "API_TOKEN", "user", ""],
      ["secret_removed", "API_TOKEN", "web", ""],
    ]);
  });

  test("capability logs older than the owner's retention (14 days by default; 0 = forever) are pruned", async () => {
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    const old = new Date(Date.now() - 15 * 86400_000).toISOString();
    t.platform.registry.addCapabilityLog("ui-counter", old, `${old} codex get@1 ok 1ms`, []);
    await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "get" });
    assert.equal(t.platform.logLines("ui-counter", 100).length, 2);
    t.platform.logRetentionDays = () => 0; // the owner keeps them forever
    assert.equal((await t.platform.cleanup()).logs, 0);
    t.platform.logRetentionDays = () => 30;
    assert.equal((await t.platform.cleanup()).logs, 0, "15 days old is within 30");
    t.platform.logRetentionDays = () => 14;
    const r = await t.platform.cleanup();
    assert.equal(r.logs, 1);
    assert.equal(t.platform.logLines("ui-counter", 100).length, 1);
  });
});

/** A capability with a write op that calls ui-counter's destructive reset. */
function counterProxy(): string {
  const dir = mkdtempSync(join(tmpdir(), "hewn-proxy-"));
  const op = { type: "object", additionalProperties: false, properties: { to: { type: "integer" } } };
  writeFileSync(
    join(dir, "capability.json"),
    JSON.stringify({
      id: "counter-proxy", name: "Counter Proxy", purpose: "Test: reaches a destructive op through a write op.", abi: "2.0",
      requires: { capabilities: [{ id: "ui-counter", operations: ["reset@1"] }] },
      operations: [{ name: "run", description: "Reset the counter", version: 1, sideEffect: "write", inputSchema: op, outputSchema: { type: "object" } }],
    }),
  );
  cpSync(join(FIXTURES, "run-feeder", "src"), join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), `type Ctx = { call: (id: string, op: string, input?: unknown) => Promise<any> };
export const operations = { "run@1": (i: { to?: number }, ctx: Ctx) => ctx.call("ui-counter", "reset@1", i) };
`);
  cpSync(join(FIXTURES, "run-feeder", "tests"), join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "tests", "cases.json"), JSON.stringify([{ name: "proxies", operation: "run", input: { to: 1 }, calls: { "ui-counter/reset@1": { count: 1 } }, expect: { count: 1 } }]));
  return dir;
}

describe("a destructive call reached through another capability", () => {
  let t: ReturnType<typeof setup>;
  const dirs: string[] = [];
  before(async () => {
    t = setup();
    t.platform.confirmWaitMs = 300;
    dirs.push(counterWithReset(), counterProxy());
    for (const d of dirs) await installFrom(t.platform, d);
    t.platform.approveGrants(USER, "counter-proxy");
    await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "increment" });
  });
  after(() => {
    t.cleanup();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const count = async () => ((await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "get" })).result as { count: number }).count;
  const run = (agent = t.claude) => t.platform.invoke(agent, { capabilityId: "counter-proxy", operation: "run", input: { to: 7 } });

  test("an agent's call waits for the owner, keyed on that agent; nothing ran", async () => {
    await assert.rejects(run(), (e: any) => e.code === "awaiting_confirmation" && /ui-counter\/reset@1 \(reached through counter-proxy\)/.test(e.message));
    assert.equal(await count(), 1);
    const [c] = t.platform.confirmations(USER);
    assert.deepEqual([c.agentId, c.capabilityId, c.operation, c.input], ["claude-code", "ui-counter", "reset@1", { to: 7 }]);
    t.platform.decideConfirmation(WEB_USER, c.id, true);
    await run();
    assert.equal(await count(), 7);
  });

  test("the owner's call through the same chain isn't held", async () => {
    await t.platform.invoke(WEB_USER, { capabilityId: "counter-proxy", operation: "run", input: { to: 3 } });
    assert.equal(await count(), 3);
  });
});
