// SPDX-License-Identifier: AGPL-3.0-or-later
// The Agent Skill "build a Hewn tool": the builder brief for a client that writes a tool itself,
// generated, checked in, served by a Hewn and through hewn_docs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ABI } from "@hewntools/core/manifest.ts";
import { SKILL_PATH, SKILL_URL, skillText } from "@hewntools/core/skill.ts";
import { SERVER_INSTRUCTIONS } from "@hewntools/spec/agents.ts";
import { serverUrl } from "@hewntools/test-host/server.ts";
import { serve, setup, TOKENS } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const brief = () => readFileSync(join(ROOT, "spec", "builder-brief.md"), "utf8");

describe("the Skill: build a Hewn tool", () => {
  test("the checked-in SKILL.md is the brief's (run npm run skill after changing spec/builder-brief.md)", () => {
    assert.equal(readFileSync(join(ROOT, SKILL_PATH), "utf8"), skillText(brief()), "skills/build-a-hewn-tool/SKILL.md is stale: npm run skill");
  });

  test("it's an Agent Skill that names the three calls, and nothing only Hewn's builder's workspace has", () => {
    const s = skillText(brief());
    assert.match(s, /^---\nname: build-a-hewn-tool\ndescription: .+\n---\n/);
    for (const call of ["capabilities_pack", "capabilities_check", "capabilities_submit", "builds_wait", "baseVersion"]) assert.ok(s.includes(call), call);
    // How to read the pack's schedules, and what the check sends back.
    for (const how of ["`schedules`", "`name@version`", "`structuredContent.screenshots`", "`screenshots: false`", "`screenshots: \"all\"`"]) assert.ok(s.includes(how), how);
    // The pack downloaded and unzipped into your workspace, or paged; a new tool waits for the owner too.
    for (const how of ["`download.url`", "unzip it into your workspace", "page the pack", "fetch it once, yourself", "`paths`", "a new tool waits for the owner's approval"]) assert.ok(s.includes(how), how);
    assert.ok(!/into your folder|in your folder/.test(s), "the pack goes into your workspace");
    // What the pack gives the client, the Skill may name; what only a builder's workspace has, it may not.
    for (const word of ["BUILDER.md", "BRIEF.md", "OWNERS_WORDS.md", "attachments/", "`check` tool", "{{"]) assert.ok(!s.includes(word), `the Skill says ${word}`);
    for (const file of ["CONTRACTS.md", "OTHER_TOOLS.md", "PLATFORM_UI.css", ".hewn-contracts/"]) assert.ok(s.includes(file), file);
    assert.ok(s.includes(`this Hewn implements ${ABI}`), "the ABI filled in");
    // Everything else is the brief's own: the contract, the tests, the UI brief, the looks to avoid.
    for (const heading of brief().match(/^#{2,3} .+$/gm)!.filter((h) => !/Check your work/.test(h))) assert.ok(s.includes(heading), heading);
  });

  test("a brief that moves what the Skill swaps fails it, saying what to update", () => {
    assert.throws(() => skillText(brief().replace("named at the end of `BUILDER.md`", "named in `BUILDER.md`")), /update SWAPS/);
  });

  test("the server instructions and capabilities_pack point at it", () => {
    assert.ok(SERVER_INSTRUCTIONS.includes(SKILL_PATH));
  });
});

describe("a Hewn serves the Skill", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let base: string;
  before(async () => {
    t = setup();
    server = await serve(t.platform, t.home);
    base = serverUrl(server).replace(/\/mcp$/, "");
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test(`at ${SKILL_URL}, to anyone, as the platform's brief makes it`, async () => {
    // Where agents reach MCP (127.0.0.1); the web client's host serves it too.
    const res = await fetch(`${base}${SKILL_URL}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(await res.text(), t.platform.skill());
  });

  test("through hewn_docs: listed, read by name, out of the search", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl(server)), { requestInit: { headers: { Authorization: `Bearer ${TOKENS.codex}` } } }));
    const text = async (args: Record<string, string>) => ((await client.callTool({ name: "hewn_docs", arguments: args })).content as { text: string }[])[0].text;
    assert.ok((await text({})).includes(SKILL_PATH));
    assert.ok((await text({ page: SKILL_PATH })).includes("capabilities_submit"));
    const found = await text({ query: "write a tool yourself and submit it" });
    assert.ok(!found.includes(`--- ${SKILL_PATH}`), "no section of the Skill in a search");
    assert.match(found, /--- docs\/agents\.md#tools-an-agent-writes-itself/, "the docs' section on it is");
    const { tools } = await client.listTools();
    assert.ok(client.getInstructions()?.includes(SKILL_PATH));
    assert.equal(tools.find((x) => x.name === "capabilities_pack"), undefined, "codex can't build");
    await client.close();
  });
});
