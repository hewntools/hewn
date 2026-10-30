// SPDX-License-Identifier: AGPL-3.0-or-later
// The builder's check on the real workerd host: the builder runs in the supervisor, the check in the
// owner's Durable Object; the request goes up the build's event stream and the result comes back.
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
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
    assert.match(checks[0].text, /^PASS[^]*Your UI empty \(there.s no sample\/calls.json to fill it\)[^]*What passed:[^]*2 test cases passed/);
    // The four renders when the supervisor finds a browser (this Mac, the Linux CI); without one the check says so.
    if (findBrowser()) {
      assert.deepEqual(checks[0].images.map((i) => i.name), ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"]);
      assert.equal(Buffer.from(checks[0].images[0].png).subarray(1, 4).toString(), "PNG");
    } else assert.match(checks[0].text, /No screenshots/);
  });
});
