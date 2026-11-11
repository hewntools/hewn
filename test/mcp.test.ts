// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serverUrl } from "@hewntools/test-host/server.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { FIXTURES, installFrom, installSeed, serve, setup, TOKENS } from "./helpers.ts";

async function connect(url: string, token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("Hewn over MCP", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let url: string;

  before(async () => {
    t = setup();
    await installSeed(t.platform);
    server = await serve(t.platform, t.home);
    url = serverUrl(server);
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("rejects missing or bad tokens", async () => {
    const res = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
    await assert.rejects(connect(url, "wrong"));
  });

  test("tools are filtered by scope", async () => {
    const claude = await connect(url, TOKENS.claude);
    const codex = await connect(url, TOKENS.codex);
    const names = async (c: Client) => (await c.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(await names(claude), [
      "builds_cancel",
      "builds_get",
      "builds_retry",
      "builds_wait",
      "capabilities_add_widgets",
      "capabilities_check",
      "capabilities_create",
      "capabilities_get",
      "capabilities_invoke",
      "capabilities_list",
      "capabilities_modify",
      "capabilities_pack",
      "capabilities_request_access",
      "capabilities_submit",
      "hewn_docs",
      "schedules_list",
      "schedules_propose",
      "widgets_show",
    ]);
    assert.deepEqual(await names(codex), ["capabilities_get", "capabilities_invoke", "capabilities_list", "capabilities_request_access", "hewn_docs", "schedules_list", "schedules_propose", "widgets_show"]);
    await claude.close();
    await codex.close();
  });

  test("claude records, a separate codex connection reads it back", async () => {
    const claude = await connect(url, TOKENS.claude);
    const rec = await claude.callTool({
      name: "capabilities_invoke",
      arguments: { capabilityId: "running-log", operation: "record_run", operationVersion: 1, input: { distanceKm: 5, durationSeconds: 1680 } },
    });
    assert.ok(!rec.isError, JSON.stringify(rec));
    await claude.close();

    const codex = await connect(url, TOKENS.codex);
    const list = parse(await codex.callTool({ name: "capabilities_list", arguments: {} }));
    assert.equal(list.capabilities[0].id, "running-log");
    assert.deepEqual(list.connections, []);
    const summary = parse(await codex.callTool({ name: "capabilities_invoke", arguments: { capabilityId: "running-log", operation: "get_summary" } }));
    assert.equal(summary.result.runCount, 1);
    await codex.close();
  });

  test("capabilities_get shows an agent that can change a tool the changes on their way", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.queue(() => gate);
    const b = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "add a pace column" });
    const claude = await connect(url, TOKENS.claude);
    const codex = await connect(url, TOKENS.codex);
    const got = parse(await claude.callTool({ name: "capabilities_get", arguments: { capabilityId: "running-log" } }));
    assert.deepEqual(got.changesComing.map((c: any) => [c.buildId, c.kind, c.request]), [[b.buildId, "modify", "add a pace column"]]);
    assert.equal(parse(await codex.callTool({ name: "capabilities_get", arguments: { capabilityId: "running-log" } })).changesComing, undefined, "not for an agent that can't change it");
    release();
    await t.platform.settle(b.buildId);
    assert.equal(parse(await claude.callTool({ name: "capabilities_get", arguments: { capabilityId: "running-log" } })).changesComing, undefined, "none once it's live");
    await claude.close();
    await codex.close();
  });

  test("platform errors come back as tool errors", async () => {
    const codex = await connect(url, TOKENS.codex);
    const r = await codex.callTool({
      name: "capabilities_invoke",
      arguments: { capabilityId: "running-log", operation: "record_run", input: { distanceKm: -5 } },
    });
    assert.equal(r.isError, true);
    assert.equal(parse(r).error, "invalid_input");
    await codex.close();
  });

  describe("discovery", () => {
    const toolsFor = async (token: string) => {
      const c = await connect(url, token);
      const { tools } = await c.listTools();
      const instructions = c.getInstructions() ?? "";
      await c.close();
      return { tools, instructions };
    };

    test("descriptions and instructions name the user's capabilities", async () => {
      const { tools, instructions } = await toolsFor(TOKENS.codex);
      assert.match(tools.find((x) => x.name === "capabilities_list")!.description!, /Running Log \(running-log\)/);
      assert.match(tools.find((x) => x.name === "capabilities_invoke")!.description!, /record_run@1/);
      assert.match(instructions, /Running Log/);
      assert.ok(!tools.some((x) => x.name.startsWith("running_log__")));
    });

    test("the catalog respects visibility", async () => {
      const { tools } = await toolsFor(TOKENS.outsider);
      assert.match(tools.find((x) => x.name === "capabilities_list")!.description!, /no capabilities yet/);
    });

    test("connections are listed apart from the user's capabilities", async () => {
      await installFrom(t.platform, join(FIXTURES, "login-connection"));
      const c = await connect(url, TOKENS.codex);
      const list = parse(await c.callTool({ name: "capabilities_list", arguments: {} }));
      assert.deepEqual(list.capabilities.map((x: any) => x.id), ["running-log"]);
      assert.deepEqual(list.connections.map((x: any) => [x.id, x.kind]), [["login-connection", "connection"]]);
      const instructions = c.getInstructions() ?? "";
      assert.ok(instructions.indexOf("Connections (external services") > instructions.indexOf("Running Log"));
      assert.match(instructions, /Connections \(external services[^]*login-connection/);
      await c.close();
    });
  });
});

describe("a client writes a tool over MCP: pack, check, submit", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let url: string;
  const lines: string[] = [];
  const SHOTS = ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"];

  before(async () => {
    t = setup({ visualCheck: async () => ({ errors: [], screenshot: Buffer.from("png"), shots: SHOTS.map((name) => ({ name, png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]) })) }) });
    await installSeed(t.platform);
    server = await serve(t.platform, t.home, { log: (l) => lines.push(l) });
    url = serverUrl(server);
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("the pack as files, the check's renders as images, the submission as a build; the log never carries the files", async () => {
    const claude = await connect(url, TOKENS.claude);
    const pack = parse(await claude.callTool({ name: "capabilities_pack", arguments: { kind: "modify", capabilityId: "running-log" } }));
    assert.equal(pack.baseVersion, 1);
    const own = pack.files.filter((f: { path: string }) => !/^(CONTRACTS\.md|OTHER_TOOLS\.md|PLATFORM_UI\.css|\.hewn-contracts\/)/.test(f.path));
    const files = own.map((f: { path: string; content: string }) => (f.path === "capability.json" ? { ...f, content: f.content.replace(/"purpose": "([^"]*)"/, '"purpose": "$1 (reworded)"') } : f));

    const checked = await claude.callTool({ name: "capabilities_check", arguments: { files, capabilityId: "running-log" } });
    assert.ok(!checked.isError, JSON.stringify(checked));
    const content = checked.content as { type: string; text?: string; mimeType?: string }[];
    assert.match(content[0].text!, /^PASS/);
    assert.equal(content.filter((c) => c.type === "image" && c.mimeType === "image/png").length, 0, "Running Log has no screen to render");
    assert.equal((checked.structuredContent as { passed: boolean }).passed, true);

    const refused = await claude.callTool({ name: "capabilities_submit", arguments: { files: pack.files, capabilityId: "running-log", request: "reword" } });
    assert.equal(refused.isError, true);
    assert.match(parse(refused).message, /PLATFORM_UI\.css: Hewn writes these for builders/);

    const b = parse(await claude.callTool({ name: "capabilities_submit", arguments: { files, capabilityId: "running-log", request: "reword the purpose", baseVersion: 1 } }));
    assert.equal(b.builder, "submitted");
    const done = parse(await claude.callTool({ name: "builds_wait", arguments: { buildId: b.buildId, timeoutSeconds: 60 } }));
    assert.equal(done.status, "review", done.log.join("\n"));
    assert.equal(done.review.approval, "wait");
    const logged = lines.filter((l) => / capabilities_(check|submit) /.test(l));
    assert.ok(logged.length >= 3 && logged.every((l) => /"files":"\d+ files, \d+ KB"/.test(l) && !l.includes("record_run@1")), logged.join("\n"));
    await claude.close();
  });

  test("a new tool with a screen: four images in the check's content, their names (no image data) in structuredContent", async () => {
    const claude = await connect(url, TOKENS.claude);
    const dir = join(FIXTURES, "ui-counter");
    const files = ["capability.json", "ui/index.html", "migrations/001_init.sql", "tests/cases.json", "sample/calls.json", "src/index.ts"].map((path) => ({ path, content: readFileSync(join(dir, path), "utf8") }));
    const checked = await claude.callTool({ name: "capabilities_check", arguments: { files } });
    const content = checked.content as { type: string; data?: string; mimeType?: string }[];
    assert.equal(content.filter((c) => c.type === "image" && c.mimeType === "image/png").length, 4, JSON.stringify(content[0]));
    assert.deepEqual((checked.structuredContent as { screenshots: string[] }).screenshots, SHOTS);
    assert.ok(JSON.stringify(checked.structuredContent).length < 2000, "no base64 in structuredContent");
    const all = await claude.callTool({ name: "capabilities_check", arguments: { files, screenshots: "all" } });
    assert.deepEqual((all.structuredContent as { screenshots: string[] }).screenshots, SHOTS, "a page no longer than the screen has no further parts");
    const bare = await claude.callTool({ name: "capabilities_check", arguments: { files, screenshots: false } });
    assert.deepEqual((bare.content as { type: string }[]).map((c) => c.type), ["text"]);
    assert.deepEqual((bare.structuredContent as { screenshots: string[] }).screenshots, []);
    await claude.close();
  });
});
