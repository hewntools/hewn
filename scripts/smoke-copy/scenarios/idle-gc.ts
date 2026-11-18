// SPDX-License-Identifier: AGPL-3.0-or-later
// What the owner would check by hand after "Hewn gives memory back when it's quiet" (the idle GC): a burst of Home's
// list, then half a minute of nothing; the supervisor's tick collects once, the platform's workerd shrinks, and the
// ticks leave the idle report alone.
import { execFileSync } from "node:child_process";
import type { Scenario } from "../scenario.ts";
import { sleep } from "../scenario.ts";

/** The platform's workerd among the copy's processes (its config is config.capnp; the tools' is tools.capnp): RSS in MB. */
function platformRss(rootPid: number): number {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss=,command="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), command: m[4] }));
  const ours = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows)
      if (!ours.has(r.pid) && ours.has(r.ppid)) {
        ours.add(r.pid);
        grew = true;
      }
  }
  // Not the sandbox's wrapper (bwrap on Linux; sandbox-exec execs workerd in place).
  const p = rows.find((r) => ours.has(r.pid) && r.command.includes("config.capnp") && /workerd/.test(r.command.split(" ")[0]));
  if (!p) throw new Error("the platform's workerd isn't running under the copy");
  return Math.round(p.rss / 1024);
}

export default {
  name: "Hewn gives memory back when it's quiet (the idle GC)",
  async run(s) {
    const runs = async () => (await s.copy.admin<{ runs: number }>("idle-gc", { quietMs: 1e12 })).runs;
    const report = async () => s.copy.call<{ lastRequestAt: number | null; changedAt: number | null }>("idleActivity");
    let before = 0;
    let peak = 0;
    let after = 0;
    let n = 0;
    let quiet = { lastRequestAt: null as number | null, changedAt: null as number | null };

    await s.step("2000 loads of Home's tool list, as an open page and agents make them", async () => {
      await s.copy.signIn();
      before = platformRss(s.copy.ready.pid);
      n = await runs();
      for (let i = 0; i < 2000; i++) await s.copy.api("GET", "/api/capabilities");
      peak = platformRss(s.copy.ready.pid);
      quiet = await report();
      s.log(`platform workerd: ${before} MB before, ${peak} MB after the loads; ${n} idle GC(s) so far`);
    });

    await s.step("half a minute of nothing: the supervisor's tick collects once, and the platform shrinks", async () => {
      const t0 = Date.now();
      while ((await runs()) === n) {
        if (Date.now() - t0 > 60_000) throw new Error(`no idle GC within 60 s of the last load (still ${platformRss(s.copy.ready.pid)} MB)`);
        await sleep(1000);
      }
      const waited = Math.round((Date.now() - t0) / 1000);
      await sleep(2000);
      after = platformRss(s.copy.ready.pid);
      s.log(`idle GC after ${waited} s of quiet: platform workerd ${peak} → ${after} MB`);
      if (after >= peak) throw new Error(`the platform didn't shrink: ${peak} → ${after} MB`);
    });

    await s.step("no second one while nothing happens, and the ticks leave the idle report alone", async () => {
      const m = await runs();
      await sleep(12_000);
      if ((await runs()) !== m) throw new Error("another idle GC with nothing done since");
      const now = await report();
      if (now.lastRequestAt !== quiet.lastRequestAt || now.changedAt !== quiet.changedAt) throw new Error(`the idle report moved: ${JSON.stringify(quiet)} → ${JSON.stringify(now)}`);
    });
  },
} satisfies Scenario;
