// SPDX-License-Identifier: AGPL-3.0-or-later
// The builder's check on the real workerd host: the builder runs in the supervisor, the check in the
// owner's Durable Object; the request goes up the build's event stream and the result comes back.
import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { CheckResult } from "@hewntools/core/ports.ts";
import { findBrowser } from "@hewntools/cli/visual.ts";
import { FIXTURES } from "./helpers.ts";
import { parse, startTestHost, type TestHost } from "./workerd-helpers.ts";

describe("the builder's check on the workerd host", () => {
  let h: TestHost;
  before(async () => (h = await startTestHost()));
  after(() => h?.stop());

  test("a check the builder asks for is run in the core and answered, images and all; the build goes on", { timeout: 180_000 }, async () => {
    const checks: CheckResult[] = [];
    h.queue(async (ws, job) => {
      cpSync(join(FIXTURES, "ui-counter"), ws, { recursive: true });
      checks.push(await job.check!("c1"));
    });
    const claude = await h.agent("claude-code", ["discover", "invoke", "create", "modify"]);
    const opened = parse(await claude.callTool({ name: "capabilities_create", arguments: { name: "UI Counter", purpose: "count", requirements: "test" } }));
    const done = parse(await claude.callTool({ name: "builds_wait", arguments: { buildId: opened.buildId, timeoutSeconds: 150 } }));
    assert.equal(done.status, "promoted", JSON.stringify(done.log));
    assert.equal(checks.length, 1);
    assert.equal(checks[0].passed, true, checks[0].text);
    assert.match(checks[0].text, /^PASS[^]*Your UI filled with your sample data[^]*What passed:[^]*2 test cases passed[^]*sample data replays \(3 calls\)/);
    // The four renders when the supervisor finds a browser (this Mac, the Linux CI); without one the check says so.
    if (findBrowser()) {
      assert.deepEqual(checks[0].images.map((i) => i.name), ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"]);
      assert.equal(Buffer.from(checks[0].images[0].png).subarray(1, 4).toString(), "PNG");
    } else assert.match(checks[0].text, /No screenshots/);
  });
});

describe("a new tool's passes on the workerd host", () => {
  let h: TestHost;
  before(async () => (h = await startTestHost({ passes: ["critique", "craft"] })));
  after(() => h?.stop());

  test("each pass reaches the builder in the supervisor with its screenshots, and the last one goes live", { skip: !findBrowser() && "no Chromium-based browser on this machine", timeout: 240_000 }, async () => {
    const seen: { attempt: number; pass?: string; shots: string[] }[] = [];
    const record = (ws: string, job: { attempt: number; pass?: { name: string } }) => seen.push({ attempt: job.attempt, pass: job.pass?.name, shots: existsSync(join(ws, "screenshots")) ? readdirSync(join(ws, "screenshots")).sort() : [] });
    h.queue(
      (ws, job) => (record(ws, job), cpSync(join(FIXTURES, "ui-counter"), ws, { recursive: true })),
      (ws, job) => void record(ws, job),
      (ws, job) => (record(ws, job), writeFileSync(join(ws, "ui", "index.html"), readFileSync(join(ws, "ui", "index.html"), "utf8").replace("</main>", "<p>crafted</p></main>"))),
    );
    const claude = await h.agent("claude-code", ["discover", "invoke", "create", "modify"]);
    const opened = parse(await claude.callTool({ name: "capabilities_create", arguments: { name: "UI Counter", purpose: "count", requirements: "test" } }));
    const done = parse(await claude.callTool({ name: "builds_wait", arguments: { buildId: opened.buildId, timeoutSeconds: 200 } }));
    assert.equal(done.status, "promoted", JSON.stringify(done.log));
    assert.deepEqual(seen.map((s) => [s.attempt, s.pass ?? null]), [[1, null], [2, "critique"], [3, "craft"]]);
    assert.deepEqual(seen[0].shots, []);
    for (const s of seen.slice(1)) assert.ok(["desktop-dark.png", "desktop-light.png", "mobile-dark.png", "mobile-light.png"].every((f) => s.shots.includes(f)), JSON.stringify(s.shots));
    assert.ok(done.log.some((l: string) => /^craft pass: promoted: implementation v1/.test(l)), JSON.stringify(done.log));
  });
});
