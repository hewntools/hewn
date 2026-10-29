// SPDX-License-Identifier: AGPL-3.0-or-later
// Integration: the real workerd host, started by the supervisor. Slower than the unit tests.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { DOC_PAGES } from "@hewntools/core/docs.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { startSupervisor, type Supervisor } from "@hewntools/cli/supervisor/index.ts";
import { editJson, editText, type Script, SEED } from "./helpers.ts";
import { oauthToken, onFreePorts } from "./workerd-helpers.ts";

const FIX = resolve(import.meta.dirname, "fixtures");
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("workerd host (integration)", () => {
  let root: string;
  let port: number;
  let sv: Supervisor;
  let token: string;
  const scripts: Script[] = [];
  const invoke = (capabilityId: string, operation: string, input: unknown = {}) => sv.admin("invoke", { capabilityId, operation, input });
  const modify = (capabilityId: string, ...edits: Script[]) => {
    scripts.push(...edits);
    return sv.admin("modify", { capabilityId, request: "test change", wait: true });
  };

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "hewn-workerd-"));
    const home = openHome(root);
    // The platform's builder, played by queued scripts (as in the unit tests).
    const scripted: CapabilityBuilder = {
      name: "claude",
      build: async (job) => {
        const s = scripts.shift();
        if (!s) throw new Error("no script queued");
        await s(job.workspace, job as any);
      },
    };
    ({ sv, port } = await onFreePorts((ports, log) => startSupervisor({ home, ...ports, builders: { claude: scripted }, log, watchdog: { intervalMs: 200, stallMs: 1500 }, keySource: "file" })));
    token = await oauthToken(sv.url, sv.admin, "claude-code", ["discover", "invoke", "create", "modify"]);
    await sv.admin("settings", { maxBuildAttempts: 1 });
  });
  after(async () => {
    await sv?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("install → validate → promote → invoke, on workerd (seed code unchanged)", async () => {
    const build = await sv.admin("install", { name: "Running Log", purpose: "runs", dir: SEED, wait: true });
    assert.equal(build.status, "promoted", build.log.join("\n"));
    const rec = await invoke("running-log", "record_run", { distanceKm: 5, durationSeconds: 1680, date: "2026-10-03" });
    assert.ok(rec.result.runId);
    assert.equal((await invoke("running-log", "get_summary")).result.totalDistanceKm, 5);
  });

  test("an agent creates a capability over MCP; the platform builder builds it; it's usable", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${sv.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    scripts.push((ws) => {
      cpSync(SEED, ws, { recursive: true });
      editJson(join(ws, "capability.json"), (m) => ((m.id = "bike-log"), (m.name = "Bike Log")));
    });
    const opened = parse(await client.callTool({ name: "capabilities_create", arguments: { name: "Bike Log", purpose: "rides", requirements: "like running log" } }));
    assert.equal(opened.status, "building");
    const done = parse(await client.callTool({ name: "builds_wait", arguments: { buildId: opened.buildId, timeoutSeconds: 60 } }));
    assert.equal(done.status, "promoted", done.log.join("\n"));
    const list = parse(await client.callTool({ name: "capabilities_list", arguments: {} }));
    assert.deepEqual(list.capabilities.map((c: any) => c.id).sort(), ["bike-log", "running-log"]);
    const r = parse(await client.callTool({ name: "capabilities_invoke", arguments: { capabilityId: "running-log", operation: "list_runs" } }));
    assert.equal(r.result.runs.length, 1);
    await client.close();
    const bad = await fetch(`${sv.url}/mcp`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    assert.equal(bad.status, 401);
  });

  test("hewn_docs: an agent reads Hewn's docs, served to workerd from the docs and spec folders", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${sv.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const text = async (args: Record<string, string>) => ((await client.callTool({ name: "hewn_docs", arguments: args })) as any).content[0].text as string;
    assert.match(await text({}), new RegExp(`^Hewn's docs: ${DOC_PAGES.length} pages[^]*docs/concepts\\.md: Concepts[^]*spec/builder-brief\\.md:`));
    assert.match(await text({ query: "how do grants work?" }), /--- docs\/concepts\.md#grants \(Concepts › Grants\) ---/);
    assert.match(await text({ page: "spec/agents.md#hewns-docs" }), /^spec\/agents\.md#hewns-docs\n\n## Hewn's docs\n/);
    await client.close();
  });

  test("modify: an additive migration promotes and state survives; a breaking change is refused", async () => {
    const ok = await modify("running-log", (ws) => {
      writeFileSync(join(ws, "migrations", "002_shoe.sql"), "ALTER TABLE runs ADD COLUMN shoe TEXT;");
    });
    assert.equal(ok.status, "promoted", ok.log.join("\n"));
    assert.ok(ok.log.some((l: string) => /upgrade dry-run ok \(002_shoe\.sql\)/.test(l)), "dry run on a copy of live state");
    assert.equal((await invoke("running-log", "list_runs")).result.runs.length, 1, "data survived the new version");

    const breaking = await modify("running-log", (ws) => editJson(join(ws, "capability.json"), (m) => m.operations[0].inputSchema.required.push("notes")));
    assert.equal(breaking.status, "failed");
    assert.match(breaking.log.join("\n"), /newly required/);
    await invoke("running-log", "record_run", { distanceKm: 1, durationSeconds: 300 });
  });

  test("a failing test case blocks promotion", async () => {
    const r = await modify("running-log", (ws) => editText(join(ws, "src", "index.ts"), (s) => s.replace("runCount: r.n,", "runCount: r.n + 1,")));
    assert.equal(r.status, "failed");
    assert.match(r.log.join("\n"), /test 'empty summary'/);
  });

  test("a build its builder's host pauses comes through the supervisor as paused, even without a note", async () => {
    const pause = (note: string) => () => {
      throw Object.assign(new Error(note), { paused: true });
    };
    const paused = await modify("running-log", pause("This build has used 300 points and isn't finished."));
    assert.equal(paused.status, "failed");
    assert.deepEqual(paused.failure, { title: "Paused", detail: "This build has used 300 points and isn't finished.", paused: true });
    // An empty message is still the builder's failure (not a finished build), and still a pause.
    const quiet = await modify("running-log", pause(""));
    assert.deepEqual(quiet.failure, { title: "Paused", detail: "The builder paused it.", paused: true });
  });

  test("composition through the host: not ready until granted, then calls go through", async () => {
    const feeder = await sv.admin("install", { name: "Run Feeder", purpose: "feeds", dir: join(FIX, "run-feeder"), wait: true });
    assert.equal(feeder.status, "promoted", feeder.log.join("\n"));
    await assert.rejects(invoke("run-feeder", "feed", { runs: [] }), /not ready/);
    await sv.admin("approve", { capabilityId: "run-feeder" });
    const fed = await invoke("run-feeder", "feed", { runs: [{ date: "2026-10-04", distanceKm: 8, durationSeconds: 2700 }] });
    assert.deepEqual(fed.result, { added: 1 });
    const runs = (await invoke("running-log", "list_runs")).result.runs;
    assert.ok(runs.some((r: any) => r.notes === "source: run-feeder"));
  });

  test("isolation: no host globals or files, egress only to approved hosts, own tables only", async () => {
    const built = await sv.admin("install", { name: "Probe", purpose: "probe", dir: join(FIX, "probe"), wait: true });
    assert.equal(built.status, "promoted", built.log.join("\n"));
    await sv.admin("approve", { capabilityId: "probe" });
    const probe = async (what: string, extra = {}) => (await invoke("probe", "probe", { what, ...extra })).result;
    assert.deepEqual((await probe("globals")).found, []);
    assert.equal((await probe("file")).ok, false, "no host filesystem");
    assert.equal((await probe("attach")).ok, false, "no ATTACH");
    assert.deepEqual((await probe("tables")).tables.filter((t: string) => !t.startsWith("_")), ["notes"], "only its own tables");
    assert.deepEqual(await probe("undeclared"), { ok: true, value: "denied" }, "undeclared host refused by the egress gate");
    assert.deepEqual(await probe("admin", { port }), { ok: true, value: 403 }, "the host's own admin channel is out of reach");
    const declared = await probe("declared");
    // The gate lets it through; what the remote answers (200, or a 403 rate limit on shared CI IPs) is its business.
    assert.ok((declared.ok === true && typeof declared.value === "number") || /fetch failed|network/i.test(String(declared.error)), `declared host allowed (or offline): ${JSON.stringify(declared)}`);
  });

  test("a connection's config reaches its code, and egress follows the host in it", async () => {
    const built = await sv.admin("install", { name: "Site Connection", purpose: "site", dir: join(FIX, "site-connection"), wait: true });
    assert.equal(built.status, "promoted", built.log.join("\n"));
    const call = (method: string, ...args: unknown[]) => sv.admin("call", { method, args });
    await call("setConfig", "site-connection", "SITE_URL", "https://example.com");
    await call("setSecret", "site-connection", "API_KEY", "k");
    await sv.admin("approve", { capabilityId: "site-connection" });
    assert.deepEqual((await invoke("site-connection", "site")).result, { config: { SITE_URL: "https://example.com" } });
    assert.equal((await invoke("site-connection", "site", { fetch: "https://example.org/" })).result.status, 403, "a host outside the config is refused");
    const allowed = (await invoke("site-connection", "site", { fetch: "https://example.com/" })).result.status;
    assert.notEqual(allowed, 403, "the config's host passes the gate (0 when offline)");
  });

  test("the web client works on workerd: sign in, then the API", async () => {
    const http = (path: string, cookie = "") =>
      new Promise<{ status: number; headers: Record<string, any>; body: string }>((res, rej) => {
        const r = request({ host: "127.0.0.1", port, path, headers: { host: `hewn.localhost:${port}`, ...(cookie ? { cookie } : {}), "x-hewn-ui": "1" } }, (m) => {
          let body = "";
          m.on("data", (d) => (body += d));
          m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
        });
        r.on("error", rej);
        r.end();
      });
    assert.equal((await http("/")).status, 401);
    const { ticket } = await sv.admin("web-ticket");
    const signed = await http(`/auth?ticket=${ticket}`);
    assert.equal(signed.status, 200);
    const cookie = String(signed.headers["set-cookie"]).split(";")[0];
    const page = await http("/", cookie);
    assert.equal(page.status, 200);
    assert.match(page.body, /<script/);
    // The client's modules, from app/ in the assets: JavaScript, under the page's CSP.
    const mod = await http("/app/router.js", cookie);
    assert.equal(mod.status, 200);
    assert.match(mod.headers["content-type"], /^text\/javascript/);
    assert.equal(mod.headers["content-security-policy"], page.headers["content-security-policy"]);
    const caps = JSON.parse((await http("/api/capabilities", cookie)).body);
    assert.ok(caps.some((c: any) => c.id === "running-log"));
    assert.equal((await http("/_platform/ui.css")).status, 200);
  });

  test("a tampered version blob is refused once it is loaded again (after a restart)", async () => {
    const dir = join(root, "workerd", "blobs", "versions");
    const status = await sv.admin("status");
    assert.ok(status.capabilities.some((c: any) => c.id === "bike-log"));
    // Tamper with every version of bike-log's bundle we can find (it's the only one with "Bike Log").
    let tampered = 0;
    for (const f of readdirSync(dir)) {
      const raw = readFileSync(join(dir, f), "utf8");
      if (!raw.includes(Buffer.from("Bike Log").toString("base64").slice(0, 8)) && !raw.includes("Bike Log")) continue;
      const v = JSON.parse(raw);
      v.bundle = v.bundle.replace("runCount: r.n", "runCount: 999");
      writeFileSync(join(dir, f), JSON.stringify(v));
      tampered++;
    }
    assert.ok(tampered > 0);
    await sv.restart();
    await assert.rejects(invoke("bike-log", "list_runs"), /integrity check/);
    assert.equal((await invoke("running-log", "list_runs")).result.runs.length, 3, "others unaffected; state survived the restart");
  });

  test("a capability stuck in a CPU loop: the watchdog restarts workerd and Hewn recovers", async () => {
    const before = sv.restarts();
    const started = Date.now();
    const err = await invoke("probe", "spin").catch((e) => e);
    assert.ok(err instanceof Error, "the stuck call fails instead of hanging");
    while (sv.restarts() === before && Date.now() - started < 10_000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(sv.restarts() > before, "workerd was restarted");
    while (!(await fetch(`${sv.url}/health`).then((r) => r.ok, () => false))) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await invoke("running-log", "list_runs")).result.runs.length, 3, "back to normal, data intact");
  });

  test("the admin channel needs its token", async () => {
    const res = await fetch(`${sv.url}/_admin/status`, { headers: { "x-hewn-admin": "x".repeat(48) } });
    assert.equal(res.status, 401);
  });
});
