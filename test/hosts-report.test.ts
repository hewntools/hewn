// SPDX-License-Identifier: AGPL-3.0-or-later
// The hosts report: validation runs a candidate with no network, and a host its code tried that it doesn't
// declare is a warning, never a failure, with what tried it. Only the workerd host gates the network and says
// which hosts were refused; on the Node host the runtime is told here as workerd's egress gate would tell it.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { FileEntry } from "@hewntools/core/platform.ts";
import type { CapabilityRuntime } from "@hewntools/core/ports.ts";
import { editJson, installSeed, SEED, setup } from "./helpers.ts";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { reportedHost } from "@hewntools/host-workerd/tools-channel.ts";
import { REPORTED_HOSTS } from "@hewntools/core/platform/validation.ts";
import { startTestHost } from "./workerd-helpers.ts";

/** A folder's files as a client sends them, the manifest declaring `hosts`. */
function entriesOf(dir: string, hosts: string[], rel = ""): FileEntry[] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const path = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, path)).isDirectory()) return entriesOf(dir, hosts, path);
    const content = readFileSync(join(dir, path), "utf8");
    return [{ path, content: path === "capability.json" ? JSON.stringify({ ...JSON.parse(content), requires: { hosts } }, null, 2) : content }];
  });
}

/** Each call to these operations is told these hosts were refused, as workerd's egress gate tells it once the call is over. */
function refusing(runtime: CapabilityRuntime, byOperation: Record<string, string[]>) {
  const invoke = runtime.invoke.bind(runtime);
  runtime.invoke = async (target, key, ...rest) => {
    try {
      return await invoke(target, key, ...rest);
    } finally {
      const hosts = byOperation[key];
      if (hosts) target.onRefusedHosts?.(hosts);
    }
  };
}

describe("the hosts report", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
    refusing(t.platform.runtime, { "record_run@1": ["api.example.com", "img.cdn.example", "api.evil.example"], "get_summary@1": ["api.evil.example", "track.example.net"] });
  });
  afterEach(() => t.cleanup());
  const files = () => entriesOf(SEED, ["api.example.com", "*.cdn.example"]);

  test("a client's check: a host beyond the declaration warns, with the operations that tried it, and passes; a declared one, or one under a declared *., doesn't", async () => {
    const r = await t.platform.checkFiles(t.claude, { files: files(), capabilityId: "running-log" });
    assert.equal(r.passed, true, r.text);
    const hosts = r.warnings.filter((w) => w.check === "hosts");
    assert.deepEqual(hosts.map((w) => w.message.match(/^tried to reach (\S+), a host it doesn't declare/)?.[1]).sort(), ["api.evil.example", "track.example.net"]);
    const evil = hosts.find((w) => w.message.includes("api.evil.example"))!;
    assert.match(evil.message, /\(get_summary@1, record_run@1\): when it runs, that's refused$/);
    assert.equal(evil.file, undefined, "no file to open: it was measured, not read");
    assert.match(r.text, /hosts: tried to reach track\.example\.net, a host it doesn't declare \(get_summary@1\)/);
  });

  test("a submission that tried one is held with the warning on its card and in its log", async () => {
    const b = await t.platform.settle((await t.platform.submitFiles(t.claude, { files: files(), capabilityId: "running-log", request: "hosts" })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
    assert.deepEqual(b.review!.warnings?.filter((w) => w.check === "hosts").length, 2);
    assert.ok(b.log.some((l) => /warning: hosts: tried to reach api\.evil\.example/.test(l)), b.log.join("\n"));
  });
});

describe("the hosts report's bounds and placeholders", () => {
  let t: ReturnType<typeof setup>;
  afterEach(() => t.cleanup());

  test("at most 20 hosts are named, the rest counted in one more warning; at most 5 operations a host", async () => {
    t = setup();
    await installSeed(t.platform);
    refusing(t.platform.runtime, { "record_run@1": Array.from({ length: 30 }, (_, i) => `h${i}.example.net`) });
    const r = await t.platform.checkFiles(t.claude, { files: entriesOf(SEED, []), capabilityId: "running-log" });
    const hosts = r.warnings.filter((w) => w.check === "hosts");
    assert.equal(hosts.length, REPORTED_HOSTS + 1);
    assert.equal(hosts.filter((w) => w.host).length, REPORTED_HOSTS);
    assert.equal(hosts.at(-1)!.message, "and 10 more hosts it doesn't declare");
  });

  test("a config:NAME host the call had no value for (a placeholder, none) isn't reported; its screen's calls are named so", async () => {
    t = setup({ visualCheck: async (req) => (await req.invoke({ operation: "get_summary", input: {} }), { errors: [], screenshot: Buffer.from("png"), shots: [] }) });
    await installSeed(t.platform);
    const runtime = t.platform.runtime;
    const invoke = runtime.invoke.bind(runtime);
    runtime.invoke = async (target, key, ...rest) => {
      try {
        return await invoke(target, key, ...rest);
      } finally {
        target.onRefusedHosts?.(target.caller?.id === "visual-check" ? ["cdn.example.org", "visual-check"] : ["undefined"]);
      }
    };
    const files = entriesOf(SEED, ["config:SITE"]).map((f) => (f.path === "capability.json" ? { ...f, content: JSON.stringify({ ...JSON.parse(f.content), abi: "2.1", config: [{ name: "SITE", description: "A site" }], ui: { available: true } }, null, 2) } : f));
    files.push({ path: "ui/index.html", content: "<!doctype html><title>x</title>" });
    const r = await t.platform.checkFiles(t.claude, { files, capabilityId: "running-log" });
    assert.deepEqual(r.warnings.filter((w) => w.check === "hosts").map((w) => w.message), ["tried to reach cdn.example.org, a host it doesn't declare (its screen): when it runs, that's refused"], r.text);
  });

  test("a refused host's name is cut at 253 characters, as a host name can't be longer", () => {
    assert.equal(reportedHost("a".repeat(300)).length, 253);
    assert.equal(reportedHost("api.example.com"), "api.example.com");
  });
});

test("on the workerd host, the egress gate says which hosts it refused: a declared host isn't reported, another is", async () => {
  const h = await startTestHost();
  const dir = mkdtempSync(join(tmpdir(), "hewn-hosts-"));
  try {
    cpSync(SEED, dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => {
      m.requires = { hosts: ["api.example.com"] };
      m.operations.push({ name: "ping", description: "Test", version: 1, sideEffect: "read", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object" } });
    });
    // Validation has no network: both are refused, and the code carries on.
    appendFileSync(join(dir, "src/index.ts"), `\n(operations as Record<string, unknown>)["ping@1"] = async () => { for (const u of ["https://api.example.com/a", "https://api.evil.example/b", "https://${"a".repeat(300)}.example/c"]) await fetch(u).catch(() => undefined); return {}; };\n(operations as Record<string, unknown>)["spray@1"] = async () => { for (let i = 0; i < 40; i++) await fetch(\`https://spray\${i}.example/\`).catch(() => undefined); return {}; };\n`);
    editJson(join(dir, "capability.json"), (m) => m.operations.push({ name: "spray", description: "Test", version: 1, sideEffect: "read", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object" } }));
    editJson(join(dir, "tests/cases.json"), (c) => c.push({ name: "ping", operation: "ping", input: {} }));
    const b = await h.sv.admin("install", { name: "Running Log", purpose: "x", dir, wait: true });
    assert.equal(b.status, "promoted", b.log.join("\n"));
    const log = b.log.join("\n");
    assert.match(log, /warning: hosts: tried to reach api\.evil\.example, a host it doesn't declare \(ping@1\)/);
    assert.doesNotMatch(log, /tried to reach api\.example\.com/);
    // The live tool's calls report nothing: 40 refused hosts out of it leave nothing behind for a build to find.
    await h.sv.admin("call", { method: "approveGrants", args: ["running-log"] });
    await h.invoke("running-log", "spray", {});
    // Two checks of the same files at once, by two clients: each finds its own hosts, a long one cut at 253 characters.
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const path = join(d.parentPath, d.name).slice(dir.length + 1);
        return { path, content: readFileSync(join(dir, path), "utf8") };
      });
    const clients = [await h.agent("claude-code", ["discover", "invoke", "create", "modify"]), await h.agent("codex", ["discover", "invoke", "create", "modify"])];
    const checks = await Promise.all(clients.map(async (c) => (await c.callTool({ name: "capabilities_check", arguments: { files, capabilityId: "running-log", screenshots: false } }, CallToolResultSchema, { timeout: 180_000 })).structuredContent as { warnings: unknown[] }));
    for (const r of checks) {
      const hosts = (r.warnings as { check: string; host?: string }[]).filter((w) => w.check === "hosts").map((w) => w.host);
      assert.ok(hosts.includes("api.evil.example"), JSON.stringify(r.warnings));
      assert.ok(hosts.some((x) => x?.startsWith("aaaa") && x.length === 253), JSON.stringify(hosts));
      assert.ok(!hosts.some((x) => x?.startsWith("spray")), "nothing from the live calls");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.stop();
  }
});
