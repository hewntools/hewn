// SPDX-License-Identifier: AGPL-3.0-or-later
// The builder's `check` tool: validation's steps on the work in progress, without promoting, going on
// after a failure, with the UI rendered; on this machine through a stdio MCP shim and files in the
// workspace's scratch folder, and only ever that build's workspace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import type { CheckResult } from "@hewntools/core/ports.ts";
import { MAX_CHECKS, type Validation } from "@hewntools/core/platform/validation.ts";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import type { VisualCheck } from "@hewntools/cli/visual.ts";
import { CHECK_DIR, openCheck } from "@hewntools/cli/builders/check.ts";
import { claudeArgs, codexArgs, opencodeCheck } from "@hewntools/cli/builders/cli.ts";
import { FIXTURES, platformWith, setup } from "./helpers.ts";

const SHOTS = ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"];
/** A visual check that renders nothing: four images named for the render, and a defect when asked to measure. */
const fakeVisual = (seen: { measure?: boolean }[] = []): VisualCheck => async (req) => {
  seen.push({ measure: req.measure });
  return { errors: [], screenshot: Buffer.from("png"), shots: SHOTS.map((name) => ({ name, png: Buffer.from(name) })), ...(req.measure ? { defects: ["Sticks out on the phone (390 px): div.row: 12px past the edge"] } : {}) };
};
const editFile = (path: string, edit: (s: string) => string) => writeFileSync(path, edit(readFileSync(path, "utf8")));

/** A minimal MCP client over a child's stdio. */
function mcp(command: string, args: string[]) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  let n = 0;
  const waiting = new Map<number, (m: any) => void>();
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  return {
    call: (method: string, params: unknown = {}) => new Promise<any>((r) => (waiting.set(++n, r), child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"))),
    close: () => new Promise<void>((r) => (child.once("exit", () => r()), child.stdin.end())),
  };
}

describe("the builder's check", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("failing tests and a bad widget come back as failures, with the four images; nothing about the tool changes", async () => {
    const seen: { measure?: boolean }[] = [];
    let checked: CheckResult | undefined;
    let toolDuringCheck: unknown = "unset";
    const builder: CapabilityBuilder = {
      name: "wc",
      build: async (job) => {
        cpSync(join(FIXTURES, "widget-counter"), job.workspace, { recursive: true });
        // A screen to render, a widget no template can draw, and a test that expects the wrong count.
        mkdirSync(join(job.workspace, "ui"));
        cpSync(join(FIXTURES, "ui-counter", "ui", "index.html"), join(job.workspace, "ui", "index.html"));
        editFile(join(job.workspace, "capability.json"), (s) => JSON.stringify({ ...JSON.parse(s), ui: { available: true } }));
        editFile(join(job.workspace, "src", "index.ts"), (s) => s.replace('template: "stat"', 'template: "nope"'));
        editFile(join(job.workspace, "tests", "cases.json"), (s) => s.replace('"expect": { "count": 1 }', '"expect": { "count": 2 }'));
        mkdirSync(join(job.workspace, "sample"));
        writeFileSync(join(job.workspace, "sample", "calls.json"), JSON.stringify([{ operation: "increment" }, { operation: "increment" }]));
        checked = await job.check!("c1");
        toolDuringCheck = t.platform.registry.getCapability("widget-counter")?.activeVersion ?? null;
        // Fixed, so the build itself goes through.
        rmSync(join(job.workspace, "ui"), { recursive: true });
        cpSync(join(FIXTURES, "widget-counter"), job.workspace, { recursive: true });
      },
    };
    const platform = platformWith(t.home, () => builder, { visualCheck: fakeVisual(seen), attempts: 1 });
    const done = await platform.settle((await platform.create(USER, { name: "Widget Counter", purpose: "x", requirements: "x" })).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(checked);
    assert.equal(checked.passed, false);
    assert.match(checked.text, /^FAIL: 1 problem\./);
    assert.match(checked.failures.join("\n"), /2 of 2 test cases failed/);
    assert.match(checked.failures.join("\n"), /widget count returned something no template can draw/);
    assert.match(checked.failures.join("\n"), /expected \{"count":2\}, got \{"count":1\}/);
    // The UI was still rendered (measured too), and shown back.
    assert.deepEqual(checked.images.map((i) => i.name), SHOTS);
    assert.deepEqual(checked.defects, ["Sticks out on the phone (390 px): div.row: 12px past the edge"]);
    assert.deepEqual(seen.slice(0, 2), [{ measure: undefined }, { measure: true }], "the check measured it filled with the sample data");
    assert.match(checked.text, /Measured on the UI[^]*div\.row/);
    assert.match(checked.text, /Your UI filled with your sample data, at 1280 and 390 px wide[^]*screenshots\/desktop-light\.png, screenshots\/desktop-dark\.png, screenshots\/mobile-light\.png, screenshots\/mobile-dark\.png/);
    assert.match(checked.text, /What passed:\n- manifest valid/);
    assert.equal(toolDuringCheck, null, "the check created no version");
    assert.ok(!done.log.some((l) => /test cases failed/.test(l)), "the check's failures aren't the build's");
    platform.close();
  });

  test("a check that can't get past the manifest says why, with no images", async () => {
    let checked: CheckResult | undefined;
    const builder: CapabilityBuilder = {
      name: "broken",
      build: async (job) => {
        writeFileSync(join(job.workspace, "capability.json"), "{ not json");
        checked = await job.check!("c1");
        cpSync(join(FIXTURES, "ui-counter"), job.workspace, { recursive: true });
      },
    };
    const platform = platformWith(t.home, () => builder, { visualCheck: fakeVisual(), attempts: 1 });
    const done = await platform.settle((await platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" })).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(checked!.passed, false);
    assert.match(checked!.failures[0], /capability\.json is not valid JSON/);
    assert.deepEqual(checked!.images, []);
    assert.match(checked!.text, /No screenshots: the UI wasn't rendered \(fix the failures first\)/);
    platform.close();
  });

  test("on this machine: the shim answers over MCP with the text and the images, checks only this build's workspace, writes nothing through a link, and the scratch folder never reaches a version", async () => {
    const outside = mkdtempSync(join(tmpdir(), "hewn-outside-"));
    const ran: string[] = [];
    let reply: any;
    let tools: any;
    let other: any;
    const builder: CapabilityBuilder = {
      name: "cli",
      build: async (job) => {
        cpSync(join(FIXTURES, "ui-counter"), job.workspace, { recursive: true });
        // What a CLI builder does (cli.ts): the scratch folder with the shim, its CLI starting it inside the sandbox.
        const check = openCheck(job.workspace, async (id) => (ran.push(id), job.check!(id)));
        try {
          const client = mcp(check.server.command, check.server.args);
          await client.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
          tools = (await client.call("tools/list")).result.tools;
          reply = (await client.call("tools/call", { name: "check", arguments: {} })).result;
          await client.close();
          // A request is answered for this build whatever it says; and only a request of the shim's own naming is.
          writeFileSync(join(job.workspace, CHECK_DIR, "requests", "settings.json"), "{}");
          writeFileSync(join(job.workspace, CHECK_DIR, "requests", "c7.json"), JSON.stringify({ buildId: "someone-else" }));
          for (let i = 0; i < 100 && !existsSync(join(job.workspace, CHECK_DIR, "results", "c7.json")); i++) await new Promise((r) => setTimeout(r, 50));
          other = JSON.parse(readFileSync(join(job.workspace, CHECK_DIR, "results", "c7.json"), "utf8"));
          // A builder with a shell points the results at a folder of the owner's: Hewn writes nothing there.
          rmSync(join(job.workspace, CHECK_DIR, "results"), { recursive: true });
          symlinkSync(outside, join(job.workspace, CHECK_DIR, "results"));
          writeFileSync(join(job.workspace, CHECK_DIR, "requests", "c8.json"), "{}");
          for (let i = 0; i < 100 && !ran.includes("c8"); i++) await new Promise((r) => setTimeout(r, 50));
          await new Promise((r) => setTimeout(r, 300));
        } finally {
          check.close();
        }
      },
    };
    const platform = platformWith(t.home, () => builder, { visualCheck: fakeVisual(), attempts: 1 });
    const done = await platform.settle((await platform.create(USER, { name: "UI Counter", purpose: "x", requirements: "x" })).buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.deepEqual(tools.map((x: { name: string }) => x.name), ["check"]);
    assert.equal(reply.isError, false);
    assert.match(reply.content[0].text, /^PASS/);
    assert.deepEqual(reply.content.slice(1).map((c: { type: string; data: string }) => [c.type, Buffer.from(c.data, "base64").toString()]), SHOTS.map((s) => ["image", s]));
    assert.match(other.text, /^PASS[^]*implementation exports/);
    assert.deepEqual(ran, ["c1", "c7", "c8"], "settings.json isn't a request");
    assert.deepEqual(readdirSync(outside), [], "nothing written through the link");
    // The images were in screenshots/ for file tools; neither folder is part of the version.
    const files = Object.keys((await platform.loadVersion("ui-counter", 1)).files);
    assert.ok(files.includes("ui/index.html"));
    assert.deepEqual(files.filter((f) => f.startsWith(CHECK_DIR) || f.startsWith("screenshots/")), []);
    rmSync(outside, { recursive: true, force: true });
    platform.close();
  });

  test("the shim says when the check couldn't run (an error, unlike a failed check)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "hewn-ws-"));
    const check = openCheck(ws, async () => {
      throw new Error("the build ended");
    });
    const client = mcp(check.server.command, check.server.args);
    await client.call("initialize", {});
    const r = (await client.call("tools/call", { name: "check", arguments: {} })).result;
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, "check unavailable: the build ended");
    assert.equal((await client.call("tools/call", { name: "deploy", arguments: {} })).result.isError, true);
    assert.equal((await client.call("resources/list")).error.code, -32601);
    await client.close();
    check.close();
    assert.ok(!existsSync(join(ws, CHECK_DIR)), "closing removes the scratch folder");
    rmSync(ws, { recursive: true, force: true });
  });

  test(`one check at a time, and at most ${MAX_CHECKS} in an attempt`, async () => {
    const platform = platformWith(t.home, () => ({ name: "x", build: async () => {} }), { attempts: 1 });
    const validation = (platform as any).d.validation as Validation;
    let running = 0;
    let most = 0;
    validation.check = async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { passed: true, text: "PASS", failures: [], defects: [], images: [] };
    };
    const notes: string[] = [];
    const checks = validation.checksFor({ id: "b", capabilityId: "x" } as any, (l) => notes.push(l));
    const results = await Promise.all(Array.from({ length: MAX_CHECKS + 1 }, (_, i) => checks.run(`c${i + 1}`)));
    await checks.settled();
    assert.equal(most, 1);
    assert.deepEqual(results.slice(0, MAX_CHECKS).map((r) => r.passed), Array(MAX_CHECKS).fill(true));
    assert.match(results[MAX_CHECKS].text, /^No checks left: this attempt has had its 10/);
    assert.equal(notes[0], `Checking its work (1 of ${MAX_CHECKS})`);
    assert.equal(notes[1], "Check passed");
    platform.close();
  });
});

describe("the check in each builder's CLI", () => {
  const job = { buildId: "b", capabilityId: "x", kind: "create" as const, workspace: "/ws", attempt: 1, logPath: "/l.log", platformRoot: "/home" };
  const server = { command: "/usr/bin/node", args: ["/ws/.hewn-check/shim.mjs", "/ws/.hewn-check"] };

  test("Claude Code: Hewn's one MCP server, its tool allowed, nothing else", () => {
    const without = claudeArgs(job, { id: "s", resume: false });
    assert.equal(without[without.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
    assert.ok(!without.some((a) => a.startsWith("mcp__")));
    const args = claudeArgs(job, { id: "s", resume: false }, server);
    assert.ok(args.includes("--strict-mcp-config") && args.includes("--restricted"));
    assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: { hewn: server } });
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
    assert.deepEqual(allowed, ["Read", "Edit", "Write", "Glob", "Grep", "mcp__hewn__check"]);
  });

  test("Codex: the server in its config, waited on as long as a check takes, before `resume`", () => {
    assert.ok(!codexArgs(job).some((a) => a.includes("mcp_servers")));
    for (const args of [codexArgs(job, undefined, server), codexArgs(job, "thread-1", server)]) {
      assert.ok(args.includes(`mcp_servers.hewn.command="/usr/bin/node"`));
      assert.ok(args.includes(`mcp_servers.hewn.args=["/ws/.hewn-check/shim.mjs","/ws/.hewn-check"]`));
      assert.ok(args.includes("mcp_servers.hewn.tool_timeout_sec=315"));
      if (args.includes("resume")) assert.ok(args.indexOf("mcp_servers.hewn.tool_timeout_sec=315") < args.indexOf("resume"));
    }
  });

  test("OpenCode: the server with a timeout above its 60 s default, and its tool allowed over the builder's rules", () => {
    const { rules, mcp: servers } = opencodeCheck(server);
    assert.deepEqual(servers, { hewn: { type: "local", command: ["/usr/bin/node", ...server.args], enabled: true, timeout: 315_000 } });
    assert.equal(rules.permission["hewn_*"], "allow");
    assert.equal(rules.permission.bash, "deny");
  });
});
