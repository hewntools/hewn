// SPDX-License-Identifier: AGPL-3.0-or-later
// The idle report: whether Hewn is idle and when it next needs to be awake, for a host that suspends an idle Hewn.
// What counts (the owner, their agents, tool calls, builds, intake turns, streams), what doesn't (the host's own
// traffic, a page's own refreshes, a widget's reads), and catching up after a resume.
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import type { ActivityView } from "@hewntools/core/platform/activity.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import { SKILL_URL } from "@hewntools/core/skill.ts";
import { afterParam, idleLine, idleStatus } from "@hewntools/cli/supervisor/idle.ts";
import { prometheusText, startMetrics } from "@hewntools/cli/supervisor/metrics.ts";
import { FIXTURES, installFrom, installSeed, SEED, serve, setup } from "./helpers.ts";
import { freePort, startTestHost, type TestHost } from "./workerd-helpers.ts";

const T0 = Date.parse("2026-11-09T08:00:00Z");
const NOW = T0 + 3600_000;
const quiet: ActivityView = { startedAt: T0, lastRequestAt: null, lastCallAt: null, lastStreamAt: null, intakes: 0, lastIntakeAt: null, building: false, lastBuildAt: null, changedAt: null, nextAlarmAt: null };
const backedUp = { lastAt: T0, backedUpToday: true };

describe("the idle rules", () => {
  test("idle only when every reason is clear; each one flips it, by name", () => {
    assert.deepEqual(idleStatus(quiet, backedUp, { now: NOW }), { idle: true, since: new Date(T0).toISOString(), busy: [], nextAlarmAt: null, backup: { lastAt: new Date(T0).toISOString(), changedSince: false }, lastRequestAt: null, lastCallAt: null });
    const min = 60_000;
    const cases: [Partial<ActivityView>, string][] = [
      [{ lastRequestAt: NOW - 9 * min }, "request"],
      [{ lastCallAt: NOW - 9 * min }, "call"],
      [{ building: true }, "build"],
      [{ intakes: 1 }, "intake"],
      [{ lastStreamAt: NOW - 9 * min }, "stream"],
      [{ changedAt: T0 + min }, "backup"],
      [{ nextAlarmAt: NOW + 2 * min }, "alarm-soon"],
    ];
    for (const [a, reason] of cases) {
      const s = idleStatus({ ...quiet, ...a }, reason === "backup" ? { lastAt: T0, backedUpToday: false } : backedUp, { now: NOW });
      assert.equal(s.idle, false, reason);
      assert.deepEqual(s.busy, [reason]);
    }
    // Ten quiet minutes clear the clocks; a stream that wrote nothing for ten minutes (open or not) doesn't count.
    assert.equal(idleStatus({ ...quiet, lastRequestAt: NOW - 10 * min, lastCallAt: NOW - 11 * min, lastStreamAt: NOW - 10 * min }, backedUp, { now: NOW }).idle, true);
    // The host's own quiet time instead of ten minutes.
    assert.equal(idleStatus({ ...quiet, lastRequestAt: NOW - 2 * min }, backedUp, { now: NOW, afterSeconds: 60 }).idle, true);
    assert.equal(idleStatus({ ...quiet, nextAlarmAt: NOW + 3 * min }, backedUp, { now: NOW }).idle, true);
  });

  test("ten minutes' grace after a start or a resume, whatever the host's quiet time", () => {
    const min = 60_000;
    assert.deepEqual(idleStatus(quiet, backedUp, { now: T0 + 9 * min, afterSeconds: 0 }).busy, ["starting"]);
    assert.equal(idleStatus(quiet, backedUp, { now: T0 + 10 * min, afterSeconds: 0 }).idle, true);
    const resumed = NOW - 5 * min;
    assert.deepEqual(idleStatus(quiet, backedUp, { now: NOW, afterSeconds: 0, resumedAt: resumed }).busy, ["starting"], "a resume starts it again");
    assert.equal(idleStatus(quiet, backedUp, { now: NOW, afterSeconds: 0, resumedAt: resumed }).since, new Date(resumed).toISOString());
    assert.equal(idleStatus(quiet, backedUp, { now: NOW + 6 * min, afterSeconds: 600, resumedAt: resumed }).idle, true);
  });

  test("since: when the last activity ended (null while a build or an intake turn runs); a host can apply its own idle time", () => {
    const at = NOW - 20 * 60_000;
    assert.equal(idleStatus({ ...quiet, lastRequestAt: at - 1000, lastCallAt: at, lastBuildAt: at - 5000 }, backedUp, { now: NOW }).since, new Date(at).toISOString());
    for (const busy of [{ building: true }, { intakes: 1 }, { nextAlarmAt: NOW + 60_000 }]) assert.equal(idleStatus({ ...quiet, ...busy }, backedUp, { now: NOW }).since, null, JSON.stringify(busy));
    assert.equal(idleStatus({ ...quiet, changedAt: T0 + 1 }, { lastAt: T0, backedUpToday: false }, { now: NOW }).since, null, "the backup reason");
    assert.ok(idleStatus({ ...quiet, lastRequestAt: NOW - 60_000 }, backedUp, { now: NOW }).since, "the clocks' reasons keep it");
  });

  test("the backup: never an alarm; the reason only with a change since the newest backup and none made today", () => {
    const changed = { ...quiet, changedAt: T0 + 1000 };
    assert.equal(idleStatus(changed, backedUp, { now: NOW }).nextAlarmAt, null, "the backup is not an alarm");
    assert.deepEqual(idleStatus(changed, { lastAt: T0, backedUpToday: true }, { now: NOW }).busy, [], "a backup today: no reason, though a change came after it");
    assert.equal(idleStatus(changed, { lastAt: T0, backedUpToday: true }, { now: NOW }).backup.changedSince, true);
    assert.deepEqual(idleStatus(changed, { lastAt: T0 + 2000, backedUpToday: false }, { now: NOW }).busy, [], "nothing changed since the newest backup");
    assert.deepEqual(idleStatus(changed, { lastAt: null, backedUpToday: false }, { now: NOW }).busy, ["backup"], "never backed up");
    assert.deepEqual(idleStatus(quiet, { lastAt: null, backedUpToday: false }, { now: NOW }).busy, [], "nothing changed, no backup wanted");
  });

  test("?after: whole seconds up to a day, else the default; the status line", () => {
    assert.deepEqual([afterParam("60"), afterParam(null), afterParam(""), afterParam("-1"), afterParam("1.5"), afterParam("90000"), afterParam("x")], [60, 600, 600, 600, 600, 600, 600]);
    const time = (t: string) => t.slice(11, 16);
    assert.equal(idleLine(idleStatus({ ...quiet, nextAlarmAt: NOW + 7200_000 }, backedUp, { now: NOW }), time), "Idle since 08:00 · next alarm 11:00");
    assert.equal(idleLine(idleStatus({ ...quiet, building: true, changedAt: T0 + 1 }, { lastAt: T0, backedUpToday: false }, { now: NOW }), time), "Busy: build, backup · no alarm · changes since the last backup");
  });

  test("gauges: idle, each reason, the next alarm and changes since the backup; counts and times, never names", () => {
    const t = setup();
    try {
      const s = idleStatus({ ...quiet, building: true, nextAlarmAt: NOW + 7200_000, changedAt: T0 + 1 }, { lastAt: T0, backedUpToday: true }, { now: NOW });
      const text = prometheusText(t.platform.metrics(USER), "1.2.3", s);
      assert.match(text, /^hewn_idle 0$/m);
      assert.match(text, /^hewn_busy\{reason="build"\} 1$/m);
      assert.match(text, /^hewn_busy\{reason="request"\} 0$/m);
      assert.equal(text.split("\n").filter((l) => l.startsWith("hewn_busy{")).length, 8);
      assert.match(text, new RegExp(`^hewn_next_alarm_seconds ${Math.floor((NOW + 7200_000) / 1000)}$`, "m"));
      assert.match(text, /^hewn_backup_changed_since 1$/m);
      assert.match(prometheusText(t.platform.metrics(USER), "1.2.3", idleStatus(quiet, backedUp, { now: NOW })), /^hewn_next_alarm_seconds 0$/m);
    } finally {
      t.cleanup();
    }
  });
});

describe("what counts as activity", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());
  const view = () => t.platform.idleActivity();

  test("a tool call: a write wants a backup, a read doesn't; a widget's reads aren't calls; a schedule's run is one", async () => {
    await installFrom(t.platform, resolve(FIXTURES, "widget-counter"));
    const changed = view().changedAt;
    assert.ok(changed, "a promote is a change");
    await new Promise((r) => setTimeout(r, 5));
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "list_runs" });
    const read = view();
    assert.ok(read.lastCallAt && read.lastCallAt >= changed);
    assert.equal(read.changedAt, changed, "a read changes nothing");
    await new Promise((r) => setTimeout(r, 5));
    await t.platform.widget(USER, "widget-counter", "count");
    assert.equal(view().lastCallAt, read.lastCallAt, "a widget's read isn't a call");
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 5, durationSeconds: 1500 } });
    assert.ok(view().changedAt! > changed, "a write is");
    const s = t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "hourly" });
    assert.equal(view().nextAlarmAt, s.nextRunAt, "the next schedule's time");
    const before = view().lastCallAt!;
    await new Promise((r) => setTimeout(r, 5));
    await t.platform.runScheduleNow(USER, s.id);
    assert.ok(view().lastCallAt! > before, "a schedule's run is a call");
  });

  test("two passes at once (the alarm and a resume) run a due schedule once", async () => {
    const s = t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 1, durationSeconds: 300 }, cadence: "daily 06:00" });
    const other = t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 2, durationSeconds: 600 }, cadence: "daily 07:00" });
    for (const x of [s, other]) t.platform.schedules.update(x.id, { nextRunAt: Date.now() - 1000 });
    const ran = (await Promise.all([t.platform.runDueSchedules(), t.platform.runDueSchedules()])).flat();
    assert.deepEqual(ran.map((r) => r.id).sort(), [s.id, other.id].sort());
    assert.equal(((await t.platform.invoke(USER, { capabilityId: "running-log", operation: "list_runs" })).result as { runs: unknown[] }).runs.length, 2);
  });

  test("a build is busy while it's queued or running, and its end is activity", async () => {
    let finish!: () => void;
    const waiting = new Promise<void>((r) => (finish = r));
    t.queue(async (ws) => {
      await waiting;
      const { cpSync } = await import("node:fs");
      cpSync(SEED, ws, { recursive: true });
    });
    const b = await t.platform.create(USER, { name: "Second Log", purpose: "x", requirements: "x" });
    assert.equal(view().building, true);
    finish();
    await t.platform.settle(b.buildId);
    const v = view();
    assert.equal(v.building, false);
    assert.ok(v.lastBuildAt);
  });
});

describe("requests: the owner and agents count; refreshes, /health and refused requests don't", () => {
  let t: ReturnType<typeof setup>;
  let platform: Platform;
  let server: Server;
  let port: number;
  let cookie = "";
  let intakeDone: () => void = () => {};
  const http = (path: string, o: { method?: string; host?: string; headers?: Record<string, string>; body?: unknown; onData?: (chunk: string) => void; signal?: AbortSignal } = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((res, rej) => {
      const r = request(
        { host: "127.0.0.1", port, path, method: o.method ?? "GET", signal: o.signal, headers: { host: `${o.host ?? "hewn.localhost"}:${port}`, ...(cookie ? { cookie } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...o.headers } },
        (m) => {
          let body = "";
          m.on("data", (d) => ((body += d), o.onData?.(String(d))));
          m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
        },
      );
      r.on("error", rej);
      r.end(o.body !== undefined ? JSON.stringify(o.body) : undefined);
    });
  const api = (path: string, o: Parameters<typeof http>[1] = {}) => http(`/api${path}`, { ...o, headers: { "x-hewn-ui": "1", ...o.headers } });
  const tick = () => new Promise((r) => setTimeout(r, 5));

  before(async () => {
    t = setup();
    platform = t.platform;
    await installSeed(platform);
    server = await serve(platform, t.home, {
      intake: async (_req, onProgress) => {
        onProgress?.({ activity: "Thinking" });
        await new Promise<void>((r) => (intakeDone = r));
        return { kind: "questions", message: "", questions: ["Which beans?"] };
      },
    });
    port = (server.address() as AddressInfo).port;
    const r = await http(`/auth?ticket=${platform.createWebTicket(USER)}`);
    cookie = String(r.headers["set-cookie"]).split(";")[0];
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("a web request moves the clock; a page's refresh, /health and a refused request leave it alone", async () => {
    await api("/capabilities");
    const at = platform.idleActivity().lastRequestAt!;
    assert.ok(at);
    await tick();
    assert.equal((await api("/capabilities", { headers: { "x-hewn-refresh": "1" } })).status, 200);
    assert.equal((await http("/health", { host: "127.0.0.1" })).status, 200);
    const saved = cookie;
    cookie = "";
    assert.equal((await api("/capabilities")).status, 401);
    assert.equal((await http("/mcp", { host: "127.0.0.1", method: "POST", body: {} })).status, 401);
    // What anyone may load: the sign-in page's files, the OAuth metadata (a scanner on a public address).
    assert.equal((await http("/app.css")).status, 200);
    assert.equal((await http("/.well-known/oauth-authorization-server", { host: "127.0.0.1" })).status, 200);
    cookie = saved;
    assert.equal(platform.idleActivity().lastRequestAt, at);
    await tick();
    await http("/");
    assert.ok(platform.idleActivity().lastRequestAt! > at, "loading the app counts");
  });

  test("the Agent Skill is one anyone may fetch: it leaves the clocks alone", async () => {
    await api("/capabilities");
    const at = platform.idleActivity();
    await tick();
    // Where agents reach MCP, and the web client's host (signed in, here).
    for (const host of ["127.0.0.1", "hewn.localhost"]) assert.equal((await http(SKILL_URL, { host })).status, 200, host);
    assert.deepEqual(platform.idleActivity(), at, "lastRequestAt, and so since, unchanged");
    await tick();
    await api("/capabilities");
    assert.ok(platform.idleActivity().lastRequestAt! > at.lastRequestAt!, "a web request still moves it");
  });

  test("what an open page fetches on its own leaves the clocks alone: a build's events, a tool's and a build's icon", async () => {
    const glyph = '<svg viewBox="0 0 5 5"><rect x="0" y="0" width="5" height="1"/></svg>';
    assert.equal((await api("/capabilities/running-log/icon", { method: "PUT", body: { glyph } })).status, 200);
    const installed = platform.registry.recentBuilds(10).find((id) => platform.getBuild(USER, id).capabilityId === "running-log")!;
    await api("/capabilities");
    const at = platform.idleActivity();
    await tick();
    // A finished build's events replay its log, then "done"; each reconnect would again.
    const replay = await api(`/builds/${installed}/events`);
    assert.equal(replay.status, 200);
    assert.match(replay.body, /event: done/);
    assert.equal((await api("/capabilities/running-log/icon")).status, 200);
    assert.deepEqual(platform.idleActivity(), at, "lastRequestAt and lastStreamAt, and so since, unchanged");
    assert.equal(idleStatus(platform.idleActivity(), backedUp, { now: Date.now() }).since, idleStatus(at, backedUp, { now: Date.now() }).since);

    // A build that's running: its icon (written first) and its live events.
    let finish!: () => void;
    const waiting = new Promise<void>((r) => (finish = r));
    t.queue(async (ws) => {
      const { cpSync, mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(resolve(ws, "ui"), { recursive: true });
      writeFileSync(resolve(ws, "ui/icon.svg"), glyph);
      await waiting;
      cpSync(SEED, ws, { recursive: true });
    });
    const b = await platform.create(USER, { name: "Idle Log", purpose: "x", requirements: "x" });
    const before = platform.idleActivity().lastRequestAt;
    for (let i = 0; i < 50 && (await api(`/builds/${b.buildId}/icon`)).status !== 200; i++) await tick();
    assert.equal((await api(`/builds/${b.buildId}/icon`)).status, 200);
    const stop = new AbortController();
    let wrote!: () => void;
    const streamed = new Promise<void>((r) => (wrote = r));
    const live = api(`/builds/${b.buildId}/events`, { signal: stop.signal, onData: () => wrote() }).catch(() => null);
    await streamed;
    stop.abort();
    await live;
    assert.equal(platform.idleActivity().lastRequestAt, before, "the build's icon and events aren't the owner");
    finish();
    await platform.settle(b.buildId);

    // The owner's own request still counts.
    await tick();
    await api("/capabilities");
    assert.ok(platform.idleActivity().lastRequestAt! > at.lastRequestAt!, "a web request still moves it");
  });

  test("a change in the web client wants a backup; a read or a refresh doesn't", async () => {
    const before = platform.idleActivity().changedAt;
    await api("/capabilities");
    await api("/home/widgets/x/refresh", { method: "POST", headers: { "x-hewn-refresh": "1" } });
    assert.equal(platform.idleActivity().changedAt, before);
    await tick();
    assert.equal((await api("/schedules", { method: "POST", body: { capabilityId: "running-log", operation: "get_summary", cadence: "hourly" } })).status, 200);
    assert.ok(platform.idleActivity().changedAt! > (before ?? 0));
  });

  test("an intake turn is busy until it answers; its stream counts while it writes", async () => {
    let first!: () => void;
    const progressed = new Promise<void>((r) => (first = r));
    const turn = api("/intake", { method: "POST", headers: { accept: "text/event-stream" }, body: { mode: "create", messages: [{ role: "user", content: "a coffee log" }] }, onData: () => first() });
    await progressed;
    const during = platform.idleActivity();
    assert.equal(during.intakes, 1);
    assert.ok(during.lastStreamAt, "its stream wrote");
    intakeDone();
    assert.equal((await turn).status, 200);
    const done = platform.idleActivity();
    assert.equal(done.intakes, 0);
    assert.ok(done.lastIntakeAt);
  });
});

describe("the idle report on the workerd host", () => {
  let h: TestHost;
  let metrics: Server;
  let metricsPort: number;
  let wallOffset = 0;
  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${metricsPort}${path}`);
    return { status: r.status, text: await r.text() };
  };
  const status = async (q = "") => JSON.parse((await get(`/status${q}`)).text);
  before(async () => {
    h = await startTestHost({ resume: { intervalMs: 100, recheckMs: 1500, wall: () => Date.now() + wallOffset } });
    metricsPort = await freePort();
    metrics = startMetrics({ port: metricsPort, url: h.sv.url, adminToken: h.sv.adminToken, version: "1.2.3", log: () => {}, status: h.sv.status });
    await new Promise((r) => metrics.once("listening", r));
    const b = await h.sv.admin("install", { name: "Running Log", purpose: "x", dir: SEED, wait: true });
    assert.equal(b.status, "promoted", b.log.join("\n"));
  });
  after(async () => {
    await new Promise((r) => metrics?.close(r));
    await h?.stop();
  });

  test("GET /status on the metrics port: the fields, and the same in the gauges; not on Hewn's own ports", async () => {
    const s = await status();
    assert.deepEqual(Object.keys(s), ["idle", "since", "busy", "nextAlarmAt", "backup", "lastRequestAt", "lastCallAt"]);
    assert.deepEqual(Object.keys(s.backup), ["lastAt", "changedSince"]);
    assert.equal(s.backup.changedSince, true, "installed, never backed up");
    assert.ok(s.busy.includes("backup"));
    assert.ok(s.busy.includes("starting"), "just started");
    const text = (await get("/metrics")).text;
    assert.match(text, /^hewn_idle 0$/m);
    assert.match(text, /^hewn_busy\{reason="backup"\} 1$/m);
    assert.doesNotMatch(text, /running|Running Log/i);
    assert.equal((await fetch(`${h.sv.url}/status`)).status, 404);
    assert.equal((await fetch(`${h.sv.publicUrl}/status`)).status, 404);
  });

  test("the host's traffic leaves the clocks alone; an agent's request and its calls move them", async () => {
    // Approving an agent is a change (the backup below keeps it).
    const agent = await h.agent("claude-code", ["discover", "invoke"]);
    const control = (path: string) => fetch(`${h.sv.control.url}${path}`, { method: "POST", headers: { "x-hewn-control": h.sv.control.token } });
    await control("/control/backup");
    const at = await status();
    await get("/metrics");
    await status();
    await h.sv.admin("call", { method: "list", args: [] });
    await h.sv.admin("schedules", { capabilityId: "running-log" });
    await control("/control/backup");
    await control("/control/status");
    const later = await status();
    assert.deepEqual([later.lastRequestAt, later.lastCallAt, later.since], [at.lastRequestAt, at.lastCallAt, at.since]);
    // A backup clears the backup reason, and nothing changed since.
    assert.equal(later.backup.changedSince, false);
    assert.ok(!later.busy.includes("backup"));
    assert.ok(later.backup.lastAt);
    await agent.callTool({ name: "capabilities_invoke", arguments: { capabilityId: "running-log", operation: "list_runs", input: {} } });
    const moved = await status();
    assert.ok(moved.lastRequestAt > (at.lastRequestAt ?? ""));
    assert.ok(moved.lastCallAt > (at.lastCallAt ?? ""));
    assert.ok(moved.busy.includes("request") && moved.busy.includes("call"));
    assert.equal(moved.backup.changedSince, false, "a read changes nothing");
    assert.deepEqual((await status("?after=0")).busy, ["starting"], "with no quiet time asked for, only the grace after the start is left");
  });

  test("after a resume: a schedule that came due while suspended runs once, the alarm is re-armed, and the second look finds nothing more", async () => {
    const before = (await h.invoke("running-log", "list_runs")).result.runs.length;
    const s = await h.sv.admin("schedules", { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 2, durationSeconds: 600 }, cadence: "daily 06:00" });
    // Due now, and no alarm for it: as if the machine slept through its time and workerd's alarm didn't fire on wake.
    await h.sv.admin("schedules/fire", { id: s.id, arm: false });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await h.invoke("running-log", "list_runs")).result.runs.length, before, "not run yet");
    wallOffset += 120_000;
    let ran: any;
    for (let i = 0; i < 50 && !ran?.lastOutcome; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ran = (await h.sv.admin("schedules", { capabilityId: "running-log" })).find((x: any) => x.id === s.id);
    }
    assert.equal(ran.lastOutcome, "ok");
    assert.ok(ran.nextRunAt > Date.now(), "re-armed for the next day");
    assert.equal((await status()).nextAlarmAt, new Date(ran.nextRunAt).toISOString());
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await h.invoke("running-log", "list_runs")).result.runs.length, before + 1, "once, also after the second look");
  });

  test("a resume while the alarm also fires: the schedule runs once", async () => {
    const before = (await h.invoke("running-log", "list_runs")).result.runs.length;
    const s = await h.sv.admin("schedules", { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 3, durationSeconds: 900 }, cadence: "daily 05:00" });
    // The alarm armed for now fires, and the clock jumps at the same moment.
    await h.sv.admin("schedules/fire", { id: s.id });
    wallOffset += 120_000;
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal((await h.invoke("running-log", "list_runs")).result.runs.length, before + 1);
  });
});
