// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import type { Server } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import { serverUrl } from "@hewntools/test-host/server.ts";
import { platformWith, SEED, serve, setup, TOKENS } from "./helpers.ts";

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("builds_wait streams progress over MCP", () => {
  let t: ReturnType<typeof setup>;
  let platform: Platform;
  let server: Server;
  let client: Client;
  let gate: Promise<void>;
  let open!: () => void;

  beforeEach(async () => {
    t = setup();
    gate = new Promise<void>((r) => (open = r));
    const builder: CapabilityBuilder = {
      name: "fake",
      async build(job) {
        job.onActivity?.("→ Read BUILDER.md");
        await sleep(30);
        job.onActivity?.("→ Write src/index.ts");
        await gate;
        cpSync(SEED, job.workspace, { recursive: true });
      },
    };
    platform = platformWith(t.home, () => builder);
    server = await serve(platform, t.home);
    client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(serverUrl(server)), {
        requestInit: { headers: { Authorization: `Bearer ${TOKENS.claude}` } },
      }),
    );
  });

  afterEach(async () => {
    open();
    await platform.drain();
    await client.close();
    await new Promise((r) => server.close(r));
    platform.close();
    t.cleanup();
  });

  const create = async () =>
    parse(
      await client.callTool({
        name: "capabilities_create",
        arguments: { name: "Running Log", purpose: "p", requirements: "r" },
      }),
    );

  test("streams builder activity and validation steps, returns the final build", async () => {
    const { buildId, status } = await create();
    assert.equal(status, "building");

    const messages: string[] = [];
    setTimeout(open, 100);
    const r = await client.callTool({ name: "builds_wait", arguments: { buildId } }, CallToolResultSchema, {
      onprogress: (p) => void messages.push(String(p.message)),
      resetTimeoutOnProgress: true,
    });
    const final = parse(r);
    assert.equal(final.status, "promoted", JSON.stringify(final));
    assert.ok(messages.includes("→ Write src/index.ts"), messages.join("\n"));
    assert.ok(messages.some((m) => m === "[platform] validating candidate"));
    assert.ok(messages.some((m) => m.startsWith("[platform] promoted")));
  });

  test("returns current status when the wait times out", async () => {
    const { buildId } = await create();
    const r = parse(await client.callTool({ name: "builds_wait", arguments: { buildId, timeoutSeconds: 1 } }));
    assert.equal(r.status, "building");
    assert.equal(r.waitTimedOut, true);
  });

  test("finished builds return immediately", async () => {
    const { buildId } = await create();
    open();
    await platform.settle(buildId);
    const r = parse(await client.callTool({ name: "builds_wait", arguments: { buildId } }));
    assert.equal(r.status, "promoted");
  });
});
