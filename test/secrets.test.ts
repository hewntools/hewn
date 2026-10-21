// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { maskInput } from "@hewntools/core/platform.ts";
import { editJson, installFrom, setup } from "./helpers.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/secret-echo");
const code = (c: string) => (e: unknown) => e instanceof PlatformError && e.code === c;

describe("secrets and grants", () => {
  let t: ReturnType<typeof setup>;
  const whoami = (input: Record<string, unknown> = {}, agent = t.codex) =>
    t.platform.invoke(agent, { capabilityId: "secret-echo", operation: "whoami", input });

  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, FIXTURE, "Secret Echo");
  });
  afterEach(() => t.cleanup());

  test("promoted but not ready until the user provides the secret and approves", async () => {
    assert.equal(t.platform.list(t.codex)[0].ready, false);
    const { status } = t.platform.get(t.codex, "secret-echo");
    assert.deepEqual(status.missingSecrets, ["API_TOKEN"]);
    assert.deepEqual(status.pendingGrants, ["secret:API_TOKEN"]);
    assert.match(status.userAction!, /open it in the Hewn web client/);
    assert.doesNotMatch(status.userAction!, /hewn connect/, "agents are sent to the web client, never to a command");
    await assert.rejects(whoami(), code("not_ready"));
  });

  test("a failed call is kept for 'Ask builder to fix this': operation, error, input, newest first; secrets redacted", async () => {
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "TOPSECRETVALUE");
    t.platform.approveGrants(USER, "secret-echo");
    await assert.rejects(whoami({ leak: "error" }));
    await assert.rejects(whoami({ leak: "error" }, USER));
    const [last, first] = t.platform.recentFailures(USER, "secret-echo");
    assert.equal(last.caller, "user");
    assert.equal(last.operation, "whoami");
    assert.match(last.error, /upstream refused \[secret\]/);
    assert.deepEqual(JSON.parse(last.input), { leak: "error" });
    assert.equal(first.caller, "codex");
    assert.ok(!JSON.stringify(t.platform.recentFailures(USER, "secret-echo")).includes("TOPSECRETVALUE"), "never a stored secret");
    assert.throws(() => t.platform.recentFailures(t.codex, "secret-echo"), /owner/);
  });

  test("the failure record: credential-like inputs masked, kept no longer than the call log, gone with a purged tool", async () => {
    assert.deepEqual(maskInput({ q: "milk", password: "hunter2", nested: { apiKey: "k", list: [{ token: "t", n: 1 }] } }), { q: "milk", password: "[hidden]", nested: { apiKey: "[hidden]", list: [{ token: "[hidden]", n: 1 }] } });
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "TOPSECRETVALUE");
    t.platform.approveGrants(USER, "secret-echo");
    // An entry older than the log's retention (14 days by default) is dropped when the next one comes.
    t.platform.registry.setKv("failures:secret-echo", [{ at: "2020-01-01T00:00:00.000Z", caller: "user", operation: "whoami", error: "old", input: "{}", logs: [] }]);
    await assert.rejects(whoami({ leak: "error" }, USER));
    assert.equal(t.platform.recentFailures(USER, "secret-echo").length, 1);
    assert.match(t.platform.recentFailures(USER, "secret-echo")[0].error, /upstream refused/);
    await t.platform.archive(USER, "secret-echo");
    await t.platform.purge(USER, "secret-echo", "secret-echo");
    assert.equal(t.platform.registry.getKv("failures:secret-echo"), undefined, "purged with the tool");
  });

  test("secret alone is not enough: the grant must be approved too", async () => {
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "real-token-123");
    await assert.rejects(whoami(), code("not_ready"));
    assert.deepEqual(t.platform.approveGrants(USER, "secret-echo"), ["secret:API_TOKEN"]);
    const { result } = await whoami();
    assert.deepEqual(result, { tokenLength: 14, prefix: "real", secretNames: ["API_TOKEN"] });
  });

  test("undeclared secrets cannot be set", () => {
    assert.throws(() => t.platform.setSecret(USER, "secret-echo", "OTHER", "x"), code("invalid_request"));
  });

  test("capability can refresh a declared secret; undeclared updates are ignored", async () => {
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "tok");
    t.platform.approveGrants(USER, "secret-echo");
    await whoami({ rotate: true });
    assert.equal(t.platform.secrets.get("secret-echo", "API_TOKEN"), "tok-rotated");
    assert.equal(t.platform.secrets.get("secret-echo", "SOMETHING_ELSE"), undefined);
  });

  test("secret values never appear in agent-visible responses", async () => {
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "TOPSECRETVALUE");
    t.platform.approveGrants(USER, "secret-echo");
    const seen = JSON.stringify([t.platform.list(t.codex), t.platform.get(t.codex, "secret-echo"), (await whoami()).result]);
    assert.ok(!seen.includes("TOPSECRETVALUE"));
  });

  test("backstop: a result carrying a stored secret is withheld; errors and logs are redacted", async () => {
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "TOPSECRETVALUE");
    t.platform.approveGrants(USER, "secret-echo");
    await assert.rejects(whoami({ leak: "result" }), (e: unknown) => code("forbidden")(e) && !(e as Error).message.includes("TOPSECRETVALUE"));
    await assert.rejects(whoami({ leak: "error" }), (e: unknown) => !(e as Error).message.includes("TOPSECRETVALUE") && /\[secret\]/.test((e as Error).message));
    await whoami({ leak: "log" });
    await assert.rejects(whoami({ leak: "result", rotate: true }), code("forbidden"), "a refreshed value counts too");
    const logged = t.platform.logLines("secret-echo", 200).join("\n");
    assert.match(logged, /using \[secret\]/);
    assert.ok(!logged.includes("TOPSECRETVALUE"), "not in the capability log");
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", JSON.stringify({ access_token: "at-0123456789abcdef", user: "someone.long@example.com" }));
    await assert.rejects(whoami({ leak: "error" }), (e: unknown) => !(e as Error).message.includes("at-0123456789abcdef") && (e as Error).message.includes("someone.long@example.com"), "a token set: its tokens are secret, the signed-in address isn't");
  });

  test("validation uses test-case secrets, never the real one", async () => {
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "real-token");
    t.platform.approveGrants(USER, "secret-echo");
    // The test case expects the prefix "fake".
    const r = await t.build(() => t.platform.modify(t.claude, { capabilityId: "secret-echo", request: "noop" }), () => {});
    assert.equal(r.status, "promoted", r.log.join("\n"));
  });

  test("a new version requesting a new host is not usable until approved", async () => {
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "tok");
    t.platform.approveGrants(USER, "secret-echo");
    await whoami();

    const b = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "secret-echo", request: "call an API" }),
      (ws) => editJson(join(ws, "capability.json"), (m) => (m.requires.hosts = ["api.example.com"])),
    );
    assert.equal(b.status, "promoted", b.log.join("\n"));

    const { status } = t.platform.get(t.codex, "secret-echo");
    assert.deepEqual(status.pendingGrants, ["host:api.example.com"]);
    await assert.rejects(whoami(), code("not_ready"));
    t.platform.approveGrants(USER, "secret-echo");
    await whoami();
  });

  test("owner actions are refused for agents and UIs, whatever their scopes", async () => {
    const powerful = { ...t.claude, scopes: new Set(["discover", "invoke", "create", "modify"] as const) };
    const ui = { id: "ui:secret-echo", kind: "ui" as const, scopes: new Set(["discover", "invoke"] as const), capabilities: "*" as const };
    for (const p of [powerful, ui]) {
      assert.throws(() => t.platform.approveGrants(p, "secret-echo"), code("forbidden"));
      assert.throws(() => t.platform.setSecret(p, "secret-echo", "API_TOKEN", "x"), code("forbidden"));
      assert.throws(() => t.platform.revokeGrant(p, "secret-echo", "secret:API_TOKEN"), code("forbidden"));
      assert.throws(() => t.platform.agents(p), code("forbidden"));
      assert.throws(() => t.platform.updateAgent(p, "codex", { scopes: ["discover"] }), code("forbidden"));
    }
  });

  test("revoking a grant makes the capability not ready again", async () => {
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "tok");
    t.platform.approveGrants(USER, "secret-echo");
    await whoami();
    t.platform.revokeGrant(USER, "secret-echo", "secret:API_TOKEN");
    await assert.rejects(whoami(), code("not_ready"));
  });

  test("owner can edit and revoke delegated agents", () => {
    t.platform.updateAgent(USER, "codex", { scopes: ["discover"] });
    assert.deepEqual(t.platform.agents(USER).find((a) => a.id === "codex")!.scopes, ["discover"]);
    t.platform.updateAgent(USER, "codex", "revoke");
    assert.ok(!t.platform.agents(USER).some((a) => a.id === "codex"));
  });
});
