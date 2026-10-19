// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { prometheusText } from "@hewntools/cli/supervisor/metrics.ts";
import { installSeed, setup } from "./helpers.ts";

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
