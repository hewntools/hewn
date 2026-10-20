// SPDX-License-Identifier: AGPL-3.0-or-later
// The metrics endpoint: Prometheus text on HEWN_METRICS_PORT (off unless set), for a host that scrapes Hewn
// (e.g. into a managed Prometheus). Aggregates only, never what's in the tools.
import http from "node:http";

type Snapshot = {
  tools: { active: number; archived: number; unversioned: number };
  builds: Record<string, number>;
  buildSeconds7d: { count: number; sum: number };
  calls24h: Record<string, { ok: number; error: number }>;
  calls7d: Record<string, { ok: number; error: number }>;
  model: { month: string; usd: number; inputTokens: number; outputTokens: number; calls: number };
  agents: { connected: number; active7d: number };
  schedules: Record<string, number>;
  schedulesFailing: number;
};

const label = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

/** Prometheus exposition text for a snapshot. */
export function prometheusText(s: Snapshot, version: string): string {
  const out: string[] = [];
  const metric = (name: string, help: string, type: "gauge" | "counter", rows: [Record<string, string>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of rows) {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${label(v)}"`).join(",");
      out.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(value) ? value : 0}`);
    }
  };
  const calls = (window: string, c: Snapshot["calls24h"]) =>
    Object.entries(c).flatMap(([agent, t]) => [[{ window, agent, outcome: "ok" }, t.ok], [{ window, agent, outcome: "error" }, t.error]] as [Record<string, string>, number][]);
  metric("hewn_info", "Hewn version", "gauge", [[{ version }, 1]]);
  metric("hewn_tools", "Tools by state", "gauge", [[{ state: "active" }, s.tools.active], [{ state: "archived" }, s.tools.archived], [{ state: "unversioned" }, s.tools.unversioned]]);
  metric("hewn_builds", "Builds by status, all time", "gauge", Object.entries(s.builds).map(([status, n]) => [{ status }, n]));
  metric("hewn_build_seconds_7d_sum", "Total time of builds promoted in the last 7 days", "gauge", [[{}, s.buildSeconds7d.sum]]);
  metric("hewn_build_seconds_7d_count", "Builds promoted in the last 7 days", "gauge", [[{}, s.buildSeconds7d.count]]);
  metric("hewn_calls", "Tool calls by origin and outcome, from the call logs", "gauge", [...calls("24h", s.calls24h), ...calls("7d", s.calls7d)]);
  metric("hewn_model_spend_usd", "Model spend this month", "gauge", [[{ month: s.model.month }, s.model.usd]]);
  metric("hewn_model_tokens", "Model tokens this month", "gauge", [[{ month: s.model.month, direction: "input" }, s.model.inputTokens], [{ month: s.model.month, direction: "output" }, s.model.outputTokens]]);
  metric("hewn_model_calls", "Model calls this month", "gauge", [[{ month: s.model.month }, s.model.calls]]);
  metric("hewn_agents", "Connected agents", "gauge", [[{ window: "all" }, s.agents.connected], [{ window: "7d" }, s.agents.active7d]]);
  metric("hewn_schedules", "Schedules by status", "gauge", Object.entries(s.schedules).map(([status, n]) => [{ status }, n]));
  metric("hewn_schedules_failing", "Schedules with failures since their last success", "gauge", [[{}, s.schedulesFailing]]);
  return out.join("\n") + "\n";
}

/** Serve GET /metrics on all interfaces at `port`, asking the platform through the admin channel. */
export function startMetrics(o: { port: number; url: string; adminToken: string; version: string; log: (m: string) => void }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") { res.writeHead(404).end(); return; }
    try {
      const r = await fetch(`${o.url}/_admin/call`, { method: "POST", headers: { "x-hewn-admin": o.adminToken, "content-type": "application/json" }, body: JSON.stringify({ method: "metrics" }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { result } = (await r.json()) as { result: Snapshot };
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(prometheusText(result, o.version));
    } catch (e) {
      res.writeHead(503, { "content-type": "text/plain" }).end(`metrics unavailable: ${(e as Error).message}\n`);
    }
  });
  server.listen(o.port, "::", () => o.log(`metrics on :${o.port}/metrics`));
  return server;
}
