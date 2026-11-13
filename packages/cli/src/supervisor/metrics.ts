// SPDX-License-Identifier: AGPL-3.0-or-later
// The metrics endpoint: Prometheus text on HEWN_METRICS_PORT (off unless set), for a host that scrapes Hewn
// (e.g. into a managed Prometheus). Aggregates only, never what's in the tools: every label value is a fixed
// category, a month or the version, never the name of a tool, a widget or an agent.
import http from "node:http";
import { CALLER_KINDS } from "@hewntools/core/platform/housekeeping.ts";
import type { BuildStatus } from "@hewntools/core/registry.ts";
import type { ScheduleStatus } from "@hewntools/core/schedules.ts";
import { afterParam, BUSY_REASONS, type IdleStatus } from "./idle.ts";

type Snapshot = {
  tools: { active: number; archived: number; unversioned: number };
  builds: Record<string, number>;
  buildSeconds7d: { count: number; sum: number };
  calls24h: Record<string, { ok: number; error: number }>;
  calls7d: Record<string, { ok: number; error: number }>;
  toolsUsed24h: Record<string, number>;
  model: { month: string; usd: number; inputTokens: number; outputTokens: number; calls: number };
  agents: { connected: number; active7d: number };
  schedules: Record<string, number>;
  schedulesFailing: number;
};

const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

// The values a label may take; anything else is counted as "other" (the escaping below is a second guard, not the
// first). A status added in code fails the typecheck here until it's listed.
const BUILD_STATUSES = ["waiting", "open", "building", "validating", "review", "failed", "promoted", "cancelled"] as const;
const SCHEDULE_STATUSES = ["proposed", "active", "paused"] as const;
const everyStatusListed: [Exclude<BuildStatus, (typeof BUILD_STATUSES)[number]> | Exclude<ScheduleStatus, (typeof SCHEDULE_STATUSES)[number]>] extends [never] ? true : never = true;
void everyStatusListed;
const oneOf = (allowed: readonly string[]) => (v: string) => (allowed.includes(v) ? v : "other");
const caller = oneOf(CALLER_KINDS);
const buildStatus = oneOf(BUILD_STATUSES);
const scheduleStatus = oneOf(SCHEDULE_STATUSES);
const month = (v: string) => (/^\d{4}-\d{2}$/.test(v) ? v : "other");
const version = (v: string) => (/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(v) ? v : "other");
/** Counts keyed by a label value, with the value made one of its allowed ones (and those that become the same, summed). */
function allowed<T>(counts: Record<string, T>, value: (v: string) => string, add: (a: T, b: T) => T): [string, T][] {
  const out = new Map<string, T>();
  for (const [k, n] of Object.entries(counts)) {
    const v = value(k);
    out.set(v, out.has(v) ? add(out.get(v)!, n) : n);
  }
  return [...out];
}
const plus = (a: number, b: number) => a + b;

/** Prometheus exposition text for a snapshot (and the idle report, when there is one). */
export function prometheusText(s: Snapshot, appVersion: string, idle?: IdleStatus): string {
  const out: string[] = [];
  const metric = (name: string, help: string, type: "gauge" | "counter", rows: [Record<string, string>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of rows) {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${label(v)}"`).join(",");
      out.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(value) ? value : 0}`);
    }
  };
  const calls = (window: string, c: Snapshot["calls24h"]) =>
    allowed(c, caller, (a, b) => ({ ok: a.ok + b.ok, error: a.error + b.error })).flatMap(([by, t]) => [[{ window, caller: by, outcome: "ok" }, t.ok], [{ window, caller: by, outcome: "error" }, t.error]] as [Record<string, string>, number][]);
  const m = month(s.model.month);
  metric("hewn_info", "Hewn version", "gauge", [[{ version: version(appVersion) }, 1]]);
  metric("hewn_tools", "Tools by state", "gauge", [[{ state: "active" }, s.tools.active], [{ state: "archived" }, s.tools.archived], [{ state: "unversioned" }, s.tools.unversioned]]);
  metric("hewn_builds", "Builds by status, all time", "gauge", allowed(s.builds, buildStatus, plus).map(([status, n]) => [{ status }, n]));
  metric("hewn_build_seconds_7d_sum", "Total time of builds promoted in the last 7 days", "gauge", [[{}, s.buildSeconds7d.sum]]);
  metric("hewn_build_seconds_7d_count", "Builds promoted in the last 7 days", "gauge", [[{}, s.buildSeconds7d.count]]);
  metric("hewn_calls", "Tool calls by the kind of caller that called them directly, and outcome, from the call logs", "gauge", [...calls("24h", s.calls24h), ...calls("7d", s.calls7d)]);
  metric("hewn_tools_used", "Different tools called, by the kind of caller that called them directly, from the call logs", "gauge", allowed(s.toolsUsed24h, caller, plus).map(([by, n]) => [{ window: "24h", caller: by }, n]));
  metric("hewn_model_spend_usd", "Model spend this month", "gauge", [[{ month: m }, s.model.usd]]);
  metric("hewn_model_tokens", "Model tokens this month", "gauge", [[{ month: m, direction: "input" }, s.model.inputTokens], [{ month: m, direction: "output" }, s.model.outputTokens]]);
  metric("hewn_model_calls", "Model calls this month", "gauge", [[{ month: m }, s.model.calls]]);
  metric("hewn_agents", "Connected agents", "gauge", [[{ window: "all" }, s.agents.connected], [{ window: "7d" }, s.agents.active7d]]);
  metric("hewn_schedules", "Schedules by status", "gauge", allowed(s.schedules, scheduleStatus, plus).map(([status, n]) => [{ status }, n]));
  metric("hewn_schedules_failing", "Schedules with failures since their last success", "gauge", [[{}, s.schedulesFailing]]);
  if (idle) {
    metric("hewn_idle", "1 when Hewn is idle (GET /status says why not)", "gauge", [[{}, idle.idle ? 1 : 0]]);
    metric("hewn_busy", "1 for each reason Hewn isn't idle", "gauge", BUSY_REASONS.map((reason) => [{ reason }, idle.busy.includes(reason) ? 1 : 0]));
    metric("hewn_next_alarm_seconds", "When the next schedule runs (epoch seconds, 0 if none)", "gauge", [[{}, idle.nextAlarmAt ? Math.floor(Date.parse(idle.nextAlarmAt) / 1000) : 0]]);
    metric("hewn_backup_changed_since", "1 when something changed since the newest backup", "gauge", [[{}, idle.backup.changedSince ? 1 : 0]]);
  }
  return out.join("\n") + "\n";
}

/**
 * Serve GET /metrics on all interfaces at `port`, asking the platform through the admin channel, and GET /status: the
 * idle report (`?after=<seconds>`: the host's own quiet time). Neither counts as activity.
 */
export function startMetrics(o: { port: number; url: string; adminToken: string; version: string; log: (m: string) => void; status: (afterSeconds?: number) => Promise<IdleStatus> }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/status") {
      try {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await o.status(afterParam(url.searchParams.get("after")))));
      } catch (e) {
        res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: `status unavailable: ${(e as Error).message}` }));
      }
      return;
    }
    if (req.method !== "GET" || req.url !== "/metrics") { res.writeHead(404).end(); return; }
    try {
      const r = await fetch(`${o.url}/_admin/call`, { method: "POST", headers: { "x-hewn-admin": o.adminToken, "content-type": "application/json" }, body: JSON.stringify({ method: "metrics" }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { result } = (await r.json()) as { result: Snapshot };
      const idle = await o.status().catch(() => undefined);
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(prometheusText(result, o.version, idle));
    } catch (e) {
      res.writeHead(503, { "content-type": "text/plain" }).end(`metrics unavailable: ${(e as Error).message}\n`);
    }
  });
  server.listen(o.port, "::", () => o.log(`metrics on :${o.port}/metrics, the idle report on :${o.port}/status`));
  return server;
}
