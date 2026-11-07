// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { prometheusText } from "@hewntools/cli/supervisor/metrics.ts";
import { editJson, installFrom, installSeed, setup } from "./helpers.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");

describe("metrics", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("counts tools, builds, calls by kind of caller and outcome, agents and schedules: never what's in the tools", async () => {
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 5, durationSeconds: 1500 } });
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "list_runs" });
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: -1, durationSeconds: 1 } }).catch(() => {});
    t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "hourly" });

    const m = t.platform.metrics(USER);
    assert.deepEqual(m.tools, { active: 1, archived: 0, unversioned: 0 });
    assert.ok((m.builds.promoted ?? 0) >= 1, "the seed's install is a promoted build");
    assert.deepEqual(m.calls24h.agent, { ok: 2, error: 1 }, "the claude test agent's calls, as an agent's");
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

  test("Prometheus text: typed metrics; a label value that isn't one of its own is counted as other", () => {
    t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "hourly" });
    const text = prometheusText(t.platform.metrics(USER), "1.2.3");
    assert.match(text, /^# TYPE hewn_info gauge$/m);
    assert.match(text, /^hewn_info\{version="1\.2\.3"\} 1$/m);
    assert.match(text, /^hewn_tools\{state="active"\} 1$/m);
    assert.match(text, /^hewn_schedules\{status="active"\} 1$/m);
    const m = t.platform.metrics(USER);
    const odd = prometheusText({ ...m, calls24h: { ...m.calls24h, 'a"b\\c': { ok: 1, error: 0 }, "zz-tool": { ok: 2, error: 1 } }, builds: { ...m.builds, "zz-status": 3 }, model: { ...m.model, month: "zz" } }, "zz");
    assert.match(odd, /^hewn_calls\{window="24h",caller="other",outcome="ok"\} 3$/m, "both summed as other");
    assert.match(odd, /^hewn_calls\{window="24h",caller="other",outcome="error"\} 1$/m);
    assert.match(odd, /^hewn_builds\{status="other"\} 3$/m);
    assert.match(odd, /^hewn_info\{version="other"\} 1$/m);
    assert.match(odd, /^hewn_model_calls\{month="other"\} 0$/m);
    assert.doesNotMatch(odd, /zz|a\\"b/);
  });

  test("/metrics names no tool, widget or agent, and every label value is one of its own", async () => {
    // A tool, a widget and an agent with names to look for; a schedule; calls from each kind of caller.
    const dir = mkdtempSync(join(tmpdir(), "hewn-metrics-"));
    try {
      cpSync(join(FIXTURES, "widget-counter"), dir, { recursive: true });
      editJson(join(dir, "capability.json"), (c) => {
        c.id = "zz-secret-tool";
        c.name = "Zz Secret Tool";
        c.widgets[0].name = "zz_secret_widget";
        c.widgets[0].title = "Zz Secret Widget";
      });
      await installFrom(t.platform, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await installFrom(t.platform, join(FIXTURES, "run-feeder"));
    t.platform.approveGrants(USER, "run-feeder");
    const store = t.platform.agentStore;
    const named = store.authenticate(store.issue(store.approveDirect("Zz Secret Agent", ["discover", "invoke"])).access_token)!;
    await t.platform.invoke(named, { capabilityId: "zz-secret-tool", operation: "increment" });
    await t.platform.invoke(USER, { capabilityId: "zz-secret-tool", operation: "increment" });
    await t.platform.invoke(USER, { capabilityId: "run-feeder", operation: "feed", input: { runs: [{ distanceKm: 3, durationSeconds: 900 }] } });
    const page: Agent = { id: "ui:zz-secret-tool", kind: "ui", scopes: new Set(["discover", "invoke"]), capabilities: new Set(["zz-secret-tool"]) };
    await t.platform.invoke(page, { capabilityId: "zz-secret-tool", operation: "increment" });
    await t.platform.widget(USER, "zz-secret-tool", "zz_secret_widget");
    const s = t.platform.createSchedule(USER, { capabilityId: "zz-secret-tool", operation: "increment", cadence: "hourly" });
    await t.platform.runScheduleNow(USER, s.id);

    const text = prometheusText(t.platform.metrics(USER), "1.2.3");
    assert.doesNotMatch(text, /zz|secret|counter|feeder|running/i, "no tool id or name, widget name or agent name");
    assert.doesNotMatch(text, new RegExp(s.id), "no schedule id");
    // Each kind of caller is there, by kind.
    for (const kind of ["user", "agent", "ui", "widget", "schedule", "capability"]) assert.match(text, new RegExp(`^hewn_calls\\{window="24h",caller="${kind}",outcome="ok"\\} [1-9]`, "m"), kind);
    // Every label value is one of its own.
    const own: Record<string, RegExp> = {
      version: /^\d+\.\d+\.\d+$/,
      state: /^(active|archived|unversioned)$/,
      status: /^(waiting|open|building|validating|review|failed|promoted|cancelled|proposed|active|paused|other)$/,
      window: /^(24h|7d|all)$/,
      caller: /^(user|agent|ui|widget|schedule|capability|other)$/,
      outcome: /^(ok|error)$/,
      month: /^\d{4}-\d{2}$/,
      direction: /^(input|output)$/,
    };
    const labels = [...text.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v] as const);
    assert.ok(labels.length > 20);
    for (const [k, v] of labels) assert.match(v, own[k] ?? /^$ never/, `${k}="${v}"`);
  });
});
