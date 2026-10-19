// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { type CapabilityManifest, validateManifest } from "@hewntools/core/manifest.ts";
import { hostOf, resolveHosts } from "@hewntools/core/platform.ts";
import { FIXTURES, installFrom, installSeed, setup } from "./helpers.ts";

const op = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: "d", version: 1, inputSchema: { type: "object" }, outputSchema: { type: "object" }, sideEffect: "read", ...extra });
const manifest = (extra: Record<string, unknown> = {}): CapabilityManifest =>
  ({ id: "x", name: "X", purpose: "p", abi: "2.1", operations: [op("get")], ...extra }) as CapabilityManifest;
const secrets = { requires: { secrets: [{ name: "API_TOKEN", description: "t" }] } };
const healthOp = (extra: Record<string, unknown> = {}) =>
  op("health", { outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["connected", "expired", "broken"] } } }, ...extra });
const connection = (extra: Record<string, unknown> = {}) => manifest({ kind: "connection", ...secrets, operations: [healthOp(), op("get")], ...extra });

/** A copy of a fixture directory whose manifest can be edited. */
export function fixtureCopy(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `hewn-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return {
    dir,
    edit(fn: (m: Record<string, any>) => void) {
      const m = JSON.parse(readFileSync(join(dir, "capability.json"), "utf8"));
      fn(m);
      writeFileSync(join(dir, "capability.json"), JSON.stringify(m));
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("the connection kind", () => {
  test("only connections may declare secrets", () => {
    assert.match(validateManifest(manifest(secrets), "x").join("\n"), /only connections hold credentials: API_TOKEN/);
    assert.deepEqual(validateManifest(manifest({ ...secrets, kind: "capability" }), "x").length, 1);
    assert.deepEqual(validateManifest(manifest({ requires: { hosts: ["api.example.com"] } }), "x"), []);
  });

  test("kind needs ABI 2.1", () => {
    assert.match(validateManifest(manifest({ kind: "capability", abi: "2.0" }), "x").join("\n"), /"kind" needs ABI 2\.1/);
  });

  test("a connection has no UI", () => {
    assert.deepEqual(validateManifest(connection(), "x"), []);
    assert.match(validateManifest(connection({ ui: { available: true } }), "x").join("\n"), /a connection has no UI/);
  });

  test("a connection must have health@1: read, no required input, reporting connected | expired | broken", () => {
    const errs = (ops: unknown[]) => validateManifest(connection({ operations: ops }), "x").join("\n");
    assert.match(errs([op("get")]), /must have a "health@1" operation/);
    assert.match(errs([healthOp({ sideEffect: "write" })]), /health@1 must be a read operation/);
    assert.match(errs([healthOp({ inputSchema: { type: "object", required: ["x"], properties: { x: { type: "string" } } } })]), /must not require input/);
    assert.match(errs([healthOp({ outputSchema: { type: "object", properties: { ok: { type: "boolean" } } } })]), /health@1 output must match/);
    assert.match(errs([healthOp({ outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["connected", "weird"] } } } })]), /enum changed incompatibly/);
    assert.equal(errs([healthOp({ outputSchema: { type: "object", required: ["status", "detail"], properties: { status: { type: "string", enum: ["connected", "broken"] }, detail: { type: "string" } } } })]), "");
  });

  test("config: declared names, hosts derived from them, ABI 2.1", () => {
    const site = { config: [{ name: "SITE_URL", description: "u" }], requires: { ...secrets.requires, hosts: ["config:SITE_URL"] } };
    assert.deepEqual(validateManifest(connection(site), "x"), []);
    assert.match(validateManifest(connection({ requires: { ...secrets.requires, hosts: ["config:NOPE"] } }), "x").join("\n"), /no config named NOPE/);
    assert.match(validateManifest(manifest({ abi: "2.0", config: [{ name: "A", description: "a" }] }), "x").join("\n"), /"config" needs ABI 2\.1/);
    assert.equal(hostOf("https://blog.example.com/ghost/"), "blog.example.com");
    assert.equal(hostOf("Blog.example.com"), "blog.example.com");
    assert.equal(hostOf("not a host"), undefined);
    assert.equal(hostOf("localhost"), undefined);
    assert.deepEqual(resolveHosts(connection(site), { SITE_URL: "https://blog.example.com" }), ["blog.example.com"]);
    assert.deepEqual(resolveHosts(connection(site), {}), []);
  });
});

describe("connections installed", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("a capability that declares secrets is refused at install", async () => {
    const f = fixtureCopy("secret-echo");
    try {
      f.edit((m) => delete m.kind);
      const started = await t.platform.install(USER, { name: "Secret Echo", purpose: "p", builder: `copy:${f.dir}` });
      const r = await t.platform.settle(started.buildId);
      assert.equal(r.status, "failed");
      assert.match(r.log.join("\n"), /only connections hold credentials/);
    } finally {
      f.remove();
    }
  });

  test("disconnecting (removing its secret) revokes consumers' grants; signing in again doesn't restore them", async () => {
    await installFrom(t.platform, join(FIXTURES, "secret-echo"));
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "tok-12345678");
    t.platform.approveGrants(USER, "secret-echo");
    const dir = mkdtempSync(join(tmpdir(), "hewn-consumer-"));
    try {
      const empty = { type: "object", additionalProperties: false, properties: {} };
      writeFileSync(join(dir, "capability.json"), JSON.stringify({ id: "echo-user", name: "Echo User", purpose: "Test: calls secret-echo.", abi: "2.1", requires: { capabilities: [{ id: "secret-echo", operations: ["health@1"] }] }, operations: [{ name: "check", description: "Ask secret-echo", version: 1, sideEffect: "read", inputSchema: empty, outputSchema: { type: "object" } }] }));
      cpSync(join(FIXTURES, "run-feeder", "src"), join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "index.ts"), `export const operations = { "check@1": (_: unknown, ctx: any) => ctx.call("secret-echo", "health@1", {}) };\n`);
      cpSync(join(FIXTURES, "run-feeder", "tests"), join(dir, "tests"), { recursive: true });
      writeFileSync(join(dir, "tests", "cases.json"), JSON.stringify([{ name: "asks", operation: "check", input: {}, calls: { "secret-echo/health@1": { status: "connected" } }, expect: { status: "connected" } }]));
      await installFrom(t.platform, dir);
      t.platform.approveGrants(USER, "echo-user");
      assert.deepEqual((await t.platform.invoke(t.claude, { capabilityId: "echo-user", operation: "check" })).result, { status: "connected" });
      t.platform.deleteSecret(USER, "secret-echo", "API_TOKEN");
      assert.deepEqual(t.platform.readiness("echo-user").pendingGrants, ["capability:secret-echo/health@1"]);
      t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "tok-12345678");
      assert.equal(t.platform.readiness("echo-user").ready, false, "signed in again: the consumer waits for the owner");
      t.platform.approveGrants(USER, "echo-user");
      assert.equal(t.platform.readiness("echo-user").ready, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a 0.1 capability that holds a secret keeps running until it is migrated", async () => {
    await installFrom(t.platform, join(FIXTURES, "secret-echo"));
    const db = new DatabaseSync(t.home.db);
    const row = db.prepare("SELECT manifest FROM capability_versions WHERE capability_id = 'secret-echo'").get() as { manifest: string };
    const { kind: _k, ...legacy } = JSON.parse(row.manifest);
    db.prepare("UPDATE capability_versions SET manifest = ? WHERE capability_id = 'secret-echo'").run(JSON.stringify({ ...legacy, abi: undefined }));
    db.close();
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "real-token");
    t.platform.approveGrants(USER, "secret-echo");
    const { result } = await t.platform.invoke(t.claude, { capabilityId: "secret-echo", operation: "whoami" });
    assert.deepEqual((result as { prefix: string }).prefix, "real");
  });
});

describe("config", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "site-connection"));
  });
  afterEach(() => t.cleanup());

  test("missing config keeps it not ready; the owner sets it; the code reads ctx.config", async () => {
    const before = t.platform.readiness("site-connection");
    assert.deepEqual(before.missingConfig, ["SITE_URL"]);
    assert.deepEqual(before.pendingGrants.sort(), ["host:config:SITE_URL", "secret:API_KEY"]);
    assert.throws(() => t.platform.setConfig(USER, "site-connection", "SITE_URL", "not a url"), /must be a URL or host name/);
    assert.throws(() => t.platform.setConfig(USER, "site-connection", "OTHER", "x"), /does not declare config OTHER/);
    assert.throws(() => t.platform.setConfig(t.claude, "site-connection", "SITE_URL", "https://example.com"), /cannot perform owner actions/);
    t.platform.setConfig(USER, "site-connection", "SITE_URL", " https://example.com ");
    t.platform.setSecret(USER, "site-connection", "API_KEY", "k");
    const auth = t.platform.authorization("site-connection");
    assert.ok(auth.items.some((i) => i.label === "connect to the host in SITE_URL (example.com)"));
    assert.deepEqual(auth.config, [{ name: "SITE_URL", description: "The site's base URL, e.g. https://example.com", value: "https://example.com" }]);
    t.platform.approveGrants(USER, "site-connection");
    assert.equal(t.platform.readiness("site-connection").ready, true);
    const { result } = await t.platform.invoke(t.claude, { capabilityId: "site-connection", operation: "site" });
    assert.deepEqual(result, { config: { SITE_URL: "https://example.com" } });
  });
});

describe("the sign-in step (connect)", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "login-connection"));
  });
  afterEach(() => t.cleanup());

  test("validation: connect is a write operation reporting connected | needs_input", () => {
    const conn = (c: Record<string, unknown>) => validateManifest(connection({ operations: [healthOp(), op("connect", { sideEffect: "write", outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string", enum: ["connected", "needs_input"] } } }, ...c })] }), "x").join("\n");
    assert.equal(conn({}), "");
    assert.match(conn({ sideEffect: "read" }), /connect@1 \(the owner's sign-in step\) must be a write operation/);
    assert.match(conn({ outputSchema: { type: "object" } }), /connect@1 output must match/);
  });

  test("only the owner signs in, once the grants are approved; the step stores the secret", async () => {
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "login-connection", operation: "connect", input: { email: "a@example.com", password: "hunter2" } }), /sign-in step: only the owner/);
    await assert.rejects(t.platform.connect(USER, "login-connection", { email: "a@example.com", password: "hunter2" }), /not ready/, "grants first");
    t.platform.approveGrants(USER, "login-connection");
    assert.match(t.platform.readiness("login-connection").userAction!, /sign in to the service/);
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "login-connection", operation: "me" }), /not ready/);
    await assert.rejects(t.platform.connect(USER, "login-connection", { email: "a@example.com", password: "wrong-pw" }), /wrong password/, "the owner sees why");
    assert.deepEqual(await t.platform.connect(USER, "login-connection", { email: "a@example.com", password: "hunter2" }), { status: "connected" });
    assert.equal(t.platform.readiness("login-connection").ready, true);
    assert.deepEqual((await t.platform.invoke(t.claude, { capabilityId: "login-connection", operation: "me" })).result, { user: "a@example.com" });
    const trail = JSON.stringify([t.platform.logLines("login-connection", 100), t.platform.registry.authorityEvents()]);
    assert.ok(!trail.includes("hunter2") && !trail.includes("wrong-pw"), "the password is in no log, even when the step logs or throws it");
    assert.ok(t.platform.registry.authorityEvents().some((e) => e.action === "signed_in" && e.subject === "login-connection"));
  });

  test("a second step (a code), carried by state", async () => {
    t.platform.approveGrants(USER, "login-connection");
    const first = await t.platform.connect(USER, "login-connection", { email: "mfa@example.com", password: "hunter2" });
    assert.equal(first.status, "needs_input");
    assert.equal(first.message, "Enter the code we sent you");
    assert.deepEqual(first.inputSchema!.required, ["code"]);
    assert.deepEqual(await t.platform.connect(USER, "login-connection", { code: "123456", state: first.state }), { status: "connected" });
    assert.deepEqual((await t.platform.invoke(t.claude, { capabilityId: "login-connection", operation: "me" })).result, { user: "mfa@example.com" });
  });

  test("connect can't be scheduled; a connection without a sign-in step has none", async () => {
    assert.throws(() => t.platform.proposeSchedule(t.claude, { capabilityId: "login-connection", operation: "connect", cadence: "daily 07:00" }), /can't be scheduled/);
    await installFrom(t.platform, join(FIXTURES, "secret-echo"));
    await assert.rejects(t.platform.connect(USER, "secret-echo", {}), /has no sign-in step/);
  });
});

describe("Accounts", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "site-connection"));
  });
  afterEach(() => t.cleanup());

  const health = () => t.platform.connectionHealth(USER, "site-connection");

  test("health: needs setup, connected, expired, broken (a check that throws)", async () => {
    assert.equal((await health()).status, "needs_setup");
    t.platform.setConfig(USER, "site-connection", "SITE_URL", "https://example.com");
    t.platform.setSecret(USER, "site-connection", "API_KEY", "k");
    t.platform.approveGrants(USER, "site-connection");
    assert.deepEqual({ ...(await health()), checkedAt: "" }, { status: "connected", detail: "https://example.com", checkedAt: "" });
    assert.equal(t.platform.registry.capabilityLogLines("site-connection", 50).filter((l) => /health/.test(l)).length, 0, "Accounts' checks aren't call-logged");
    t.platform.setSecret(USER, "site-connection", "API_KEY", "expired");
    assert.equal((await health()).status, "expired");
    await assert.rejects(t.platform.connectionHealth(t.claude, "site-connection"), /owner actions/);
    await installSeed(t.platform);
    await assert.rejects(t.platform.connectionHealth(USER, "running-log"), /not a connection/);
  });

  test("accounts: connections only, with their users", async () => {
    await installSeed(t.platform);
    const a = await t.platform.accounts(USER);
    assert.deepEqual(a.connections.map((c) => c.id), ["site-connection"]);
    assert.deepEqual(a.connections[0].usedBy, []);
    assert.equal(a.connections[0].signIn, null);
  });

  test("Accounts reuses a live health result; a direct check or a setup change runs it again", async () => {
    t.platform.setConfig(USER, "site-connection", "SITE_URL", "https://example.com");
    t.platform.setSecret(USER, "site-connection", "API_KEY", "k");
    t.platform.approveGrants(USER, "site-connection");
    let checks = 0;
    const invoke = t.platform.invoke.bind(t.platform);
    t.platform.invoke = ((agent, req, ...rest) => (req.operation === "health" && checks++, invoke(agent, req, ...rest))) as typeof t.platform.invoke;
    const status = async () => (await t.platform.accounts(USER)).connections[0].health.status;
    assert.equal(await status(), "connected");
    assert.equal(await status(), "connected");
    assert.equal(checks, 1, "the second open is cached");
    await health();
    assert.equal(checks, 2, "a direct check is always live");
    t.platform.setSecret(USER, "site-connection", "API_KEY", "expired");
    assert.equal(await status(), "expired", "changing a secret drops the cached result");
    assert.equal(checks, 3);
  });

  test("the trail records the host a config value allows, not the value", () => {
    t.platform.setConfig(USER, "site-connection", "SITE_URL", "https://example.com/private/path?key=abc");
    const e = t.platform.registry.authorityEvents().find((x) => x.action === "config_set")!;
    assert.equal(e.detail, "host example.com");
  });

  test("grants can be approved one at a time", () => {
    t.platform.setConfig(USER, "site-connection", "SITE_URL", "https://example.com");
    const [first, ...rest] = t.platform.readiness("site-connection").pendingGrants;
    assert.ok(rest.length, "the fixture asks for more than one grant");
    t.platform.approveGrant(USER, "site-connection", first);
    assert.deepEqual(t.platform.readiness("site-connection").pendingGrants, rest);
    assert.throws(() => t.platform.approveGrant(USER, "site-connection", first), /already approved/);
    for (const g of rest) t.platform.approveGrant(USER, "site-connection", g);
    assert.deepEqual(t.platform.readiness("site-connection").pendingGrants, []);
  });
});

describe("review fixes", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "site-connection"));
  });
  afterEach(() => t.cleanup());

  test("a connection stays a connection", async () => {
    const r = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "site-connection", request: "x" }),
      (ws) => {
        const p = join(ws, "capability.json");
        const m = JSON.parse(readFileSync(p, "utf8"));
        m.kind = "capability";
        delete m.requires.secrets;
        writeFileSync(p, JSON.stringify(m));
      },
    );
    assert.equal(r.status, "failed");
    assert.match(r.log.join("\n"), /a connection stays a connection/);
  });

  test("a config value a host comes from must name a host to count as set", () => {
    const db = new DatabaseSync(t.home.db);
    db.prepare("INSERT INTO config_values (capability_id, name, value, set_by, set_at) VALUES ('site-connection', 'SITE_URL', 'not a host', 'user', '')").run();
    db.close();
    assert.deepEqual(t.platform.readiness("site-connection").missingConfig, ["SITE_URL"]);
  });

  test("usedBy counts every entry for the same callee", async () => {
    const f = fixtureCopy("run-feeder");
    try {
      await installSeed(t.platform);
      f.edit((m) => (m.requires.capabilities = [{ id: "running-log", operations: ["record_run@1"] }, { id: "running-log", operations: ["list_runs@1"] }]));
      await installFrom(t.platform, f.dir);
      assert.deepEqual(t.platform.usedBy("running-log")[0].operations, ["record_run@1", "list_runs@1"]);
    } finally {
      f.remove();
    }
  });
});
