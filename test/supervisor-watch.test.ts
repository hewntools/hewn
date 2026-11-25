// SPDX-License-Identifier: AGPL-3.0-or-later
// The supervisor survives a failed answer on its metrics port, and its watchdog backs off from restarting a workerd
// that doesn't answer (supervisor/metrics.ts, supervisor/watch.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { startMetrics } from "@hewntools/cli/supervisor/metrics.ts";
import { allowedStall, BACKOFF_MAX_MS, watchHealth } from "@hewntools/cli/supervisor/watch.ts";

const listening = (server: ReturnType<typeof startMetrics>) =>
  new Promise<number>((resolve) => (server.listening ? resolve((server.address() as { port: number }).port) : server.once("listening", () => resolve((server.address() as { port: number }).port))));

test("metrics: /status and /metrics answer 503 while the platform is down, once, and the server keeps serving", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const logs: string[] = [];
  let up = false;
  const server = startMetrics({
    port: 0, url: "http://127.0.0.1:9", adminToken: "x", version: "1.2.3", log: (m) => logs.push(m),
    // workerd restarting: the idle report can't be had.
    status: async () => { if (!up) throw new Error("workerd restarting"); return { idle: true } as never; },
  });
  t.after(() => server.close());
  const port = await listening(server);
  for (let i = 0; i < 3; i++) {
    const s = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(5000) });
    assert.equal(s.status, 503);
    assert.deepEqual(await s.json(), { error: "status unavailable: workerd restarting" });
    const m = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(5000) });
    assert.equal(m.status, 503);
    assert.match(await m.text(), /^metrics unavailable: /);
  }
  up = true;
  const s = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(5000) });
  assert.equal(s.status, 200);
  assert.deepEqual(await s.json(), { idle: true });
  assert.equal((await fetch(`http://127.0.0.1:${port}/nope`, { signal: AbortSignal.timeout(5000) })).status, 404);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(unhandled, []);
  assert.deepEqual(logs.filter((l) => !l.startsWith("metrics on")), []);
});

test("watchdog: the allowed stall doubles with each restart, up to 2 minutes", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => allowedStall(10_000, n)), [10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
  assert.equal(BACKOFF_MAX_MS, 120_000);
});

/** The watch loop on a fake clock: each health check takes a second of it. `answers` says, by the fake time, whether it answers. */
async function run(o: { backoff: boolean; answers: (t: number) => boolean; until: number; ready?: (t: number) => boolean }) {
  let clock = 0;
  const stalls: { at: number; seconds: number; next: number; again: boolean }[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const timer = watchHealth({
    intervalMs: 1, stallMs: 10_000, backoff: o.backoff, now: () => clock, ...(o.ready ? { ready: () => o.ready!(clock) } : {}),
    check: async () => { clock += 1000; if (clock >= o.until) done(); return o.answers(clock); },
    onStall: (seconds, next, again) => void stalls.push({ at: clock, seconds, next, again }),
  });
  await finished;
  clearInterval(timer);
  return stalls;
}

test("watchdog with back-off: a workerd that never answers is restarted at growing intervals, not every 11 s", async () => {
  const stalls = await run({ backoff: true, answers: () => false, until: 600_000 });
  assert.deepEqual(stalls.slice(0, 6).map((s) => s.next), [20_000, 40_000, 80_000, 120_000, 120_000, 120_000]);
  // The first restart isn't "again" (its log line has no note); the next ones are, after about 21 s, 41 s …
  assert.deepEqual(stalls.slice(0, 3).map((s) => s.again), [false, true, true]);
  assert.ok(stalls[1].seconds >= 20 && stalls[1].seconds <= 23, `${stalls[1].seconds}`);
  // Each gap is the allowed stall plus the 5 s grace after a restart; ten minutes see 7 restarts, not 50.
  const gaps = stalls.slice(1).map((s, i) => s.at - stalls[i].at);
  for (const [i, g] of gaps.entries()) assert.ok(g > allowedStall(10_000, i + 1) && g <= allowedStall(10_000, i + 1) + 8000, `gap ${i}: ${g}`);
  assert.ok(stalls.length <= 8, `${stalls.length} restarts`);
});

test("watchdog with back-off: a minute answering forgets the restarts", async () => {
  // Down for 40 s (two restarts), up from 40 s to 110 s, then down again: the next restart is the first again.
  const stalls = await run({ backoff: true, answers: (t) => t >= 40_000 && t < 110_000, until: 140_000 });
  assert.deepEqual(stalls.map((s) => s.next), [20_000, 40_000, 20_000]);
  assert.deepEqual(stalls.map((s) => s.again), [false, true, false]);
  // Up for only 30 s between two stalls: not forgotten.
  const short = await run({ backoff: true, answers: (t) => t >= 40_000 && t < 70_000, until: 140_000 });
  assert.deepEqual(short.map((s) => s.next), [20_000, 40_000, 80_000]);
});

test("watchdog without back-off (the tools): every stall past the stall rule's 10 s, as before", async () => {
  const stalls = await run({ backoff: false, answers: () => false, until: 120_000 });
  assert.ok(stalls.length >= 7, `${stalls.length} restarts`);
  assert.ok(stalls.every((s) => s.next === 10_000 && s.seconds >= 10 && s.seconds <= 12));
});

test("watchdog: a process that hasn't answered since it started isn't counted as stalled (the tools starting on a slow machine)", async () => {
  // Starting for the first 30 s (no answer), then up: no restart while it starts.
  const starting = await run({ backoff: false, answers: (t) => t >= 30_000, ready: (t) => t >= 30_000, until: 60_000 });
  assert.deepEqual(starting, []);
  // Ready, then silent: the stall rule as before, counted from when it was last ready.
  const silent = await run({ backoff: false, answers: () => false, ready: (t) => t >= 30_000, until: 50_000 });
  assert.equal(silent.length, 1);
  assert.ok(silent[0].at >= 39_000 && silent[0].seconds <= 12, JSON.stringify(silent));
});

test("metrics: a platform that doesn't answer gets a 503 after 5 s, not a scrape that hangs", async (t) => {
  const { createServer } = await import("node:http");
  const hung = createServer(() => {}); // takes the request, never answers
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
  t.after(() => { hung.closeAllConnections(); hung.close(); });
  const server = startMetrics({ port: 0, url: `http://127.0.0.1:${(hung.address() as { port: number }).port}`, adminToken: "x", version: "1.2.3", log: () => {}, status: async () => { throw new Error("down"); } });
  t.after(() => server.close());
  const port = await listening(server);
  const started = Date.now();
  const m = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(m.status, 503);
  assert.match(await m.text(), /^metrics unavailable: /);
  assert.ok(Date.now() - started < 8000, `${Date.now() - started} ms`);
});
