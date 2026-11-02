// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { join } from "node:path";
import { type Agent, USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { prometheusText } from "@hewntools/cli/supervisor/metrics.ts";
import { installFrom, installSeed, setup } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("metrics", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("counts tools, builds, calls by origin and outcome, agents and schedules: never what's in the tools", async () => {
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 5, durationSeconds: 1500 } });
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "list_runs" });
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: -1, durationSeconds: 1 } }).catch(() => {});
    t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "hourly" });

    const m = t.platform.metrics(USER);
    assert.deepEqual(m.tools, { active: 1, archived: 0, unversioned: 0 });
    assert.ok((m.builds.promoted ?? 0) >= 1, "the seed's install is a promoted build");
    const claude = Object.entries(m.calls24h).find(([agent]) => /claude/.test(agent))?.[1];
    assert.ok(claude, `calls from the claude test agent: ${JSON.stringify(m.calls24h)}`);
    assert.equal(claude.ok, 2);
    assert.equal(claude.error, 1);
    assert.deepEqual(m.calls7d, m.calls24h);
    assert.ok(m.agents.connected >= 1);
    assert.equal(m.schedules.active, 1);
    assert.equal(m.model.usd, 0);
    assert.doesNotMatch(JSON.stringify(m), /1500|distanceKm/, "no inputs or outputs");
  });

  test("tools used in the last 24 h: different tools per kind of direct caller, a tool called twice counts once, older calls don't", async () => {
    await installFrom(t.platform, join(FIXTURES, "run-feeder"));
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    t.platform.approveGrants(USER, "run-feeder");
    // The owner: Running Log twice (once), and Run Feeder, which calls Running Log itself (as a tool).
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "list_runs" });
    await t.platform.invoke(USER, { capabilityId: "running-log", operation: "get_summary" });
    await t.platform.invoke(USER, { capabilityId: "run-feeder", operation: "feed", input: { runs: [{ distanceKm: 3, durationSeconds: 900 }] } });
    // An agent: two tools, one of them twice.
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "list_runs" });
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "list_runs" });
    await t.platform.invoke(t.claude, { capabilityId: "ui-counter", operation: "get" });
    // A tool's own page.
    const page: Agent = { id: "ui:ui-counter", kind: "ui", scopes: new Set(["discover", "invoke"]), capabilities: new Set(["ui-counter"]) };
    await t.platform.invoke(page, { capabilityId: "ui-counter", operation: "get" });
    // Two days ago, an agent called a tool no agent called since: kept in the log, but not in the last 24 h.
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    t.platform.registry.addCapabilityLog("run-feeder", old, `${old} codex feed@1 ok 1ms`, []);

    const m = t.platform.metrics(USER);
    assert.deepEqual(m.toolsUsed24h, { user: 2, agent: 2, ui: 1, widget: 0, schedule: 0, capability: 1 });
    // The same counts in the Prometheus text, and never which tools.
    const text = prometheusText(m, "1.2.3");
    assert.match(text, /^# TYPE hewn_tools_used gauge$/m);
    const lines = text.split("\n").filter((l) => l.startsWith("hewn_tools_used{"));
    assert.deepEqual(lines, ['hewn_tools_used{window="24h",caller="user"} 2', 'hewn_tools_used{window="24h",caller="agent"} 2', 'hewn_tools_used{window="24h",caller="ui"} 1', 'hewn_tools_used{window="24h",caller="widget"} 0', 'hewn_tools_used{window="24h",caller="schedule"} 0', 'hewn_tools_used{window="24h",caller="capability"} 1']);
    assert.doesNotMatch(text.split("\n").filter((l) => l.includes("tools_used")).join("\n"), /running|feeder|counter|Running Log|Run Feeder|UI Counter/i);
  });

  test("owner only", () => {
    assert.throws(() => t.platform.metrics(t.claude), (e) => e instanceof PlatformError);
  });

  test("Prometheus text: typed metrics with escaped labels", () => {
    t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "hourly" });
    const text = prometheusText(t.platform.metrics(USER), "1.2.3");
    assert.match(text, /^# TYPE hewn_info gauge$/m);
    assert.match(text, /^hewn_info\{version="1\.2\.3"\} 1$/m);
    assert.match(text, /^hewn_tools\{state="active"\} 1$/m);
    assert.match(text, /^hewn_schedules\{status="active"\} 1$/m);
    const odd = prometheusText({ ...t.platform.metrics(USER), calls24h: { 'a"b\\c': { ok: 1, error: 0 } } }, "x");
    assert.match(odd, /agent="a\\"b\\\\c"/);
  });
});
