// SPDX-License-Identifier: AGPL-3.0-or-later
// The idle GC. workerd gives V8 no idle time: its platform has idle tasks off and runs V8's memory reducer only at the
// end of a request, so heap that a burst of requests grew stays committed while Hewn sits idle (on Linux the
// platform's RSS settles near a small machine's size). The supervisor asks every few seconds (/_admin/idle-gc); once
// something has run since the last collection and nothing for a while, one last-resort GC gives the heap back
// (25–100 ms). Only the platform's process has `gc` (its config's `--expose-gc`); the tools' never does.

/** Quiet this long after the last activity before the platform collects. */
export const IDLE_GC_QUIET_MS = 30_000;

/** What the platform was doing, for the idle GC: when anything last ran (epoch ms), and whether something runs now. */
export interface GcActivity {
  lastActiveAt: number;
  busy: boolean;
}

export type IdleGcAnswer = { ran: true; ms: number; runs: number } | { ran: false; why: "no gc" | "busy" | "recent" | "nothing new"; runs: number };

/** Admin calls that are the supervisor's own ticks and reads (the idle report, metrics, the disk): they don't wake the idle GC. */
export function tickCall(path: string, body: Record<string, unknown>): boolean {
  if (path === "/_admin/idle-gc" || path === "/_admin/disk") return true;
  return path === "/_admin/call" && ["idleActivity", "nextScheduleAt", "metrics"].includes(String(body.method));
}

/** One collection per quiet spell: after activity since the last, none for `quietMs`, and nothing running. */
export class IdleGc {
  private gc: ((o: object) => void) | undefined;
  private ranAt = 0;
  private runs = 0;

  constructor(gc: ((o: object) => void) | undefined) {
    this.gc = gc;
  }

  run(a: GcActivity, quietMs = IDLE_GC_QUIET_MS, now = Date.now()): IdleGcAnswer {
    const runs = this.runs;
    if (!this.gc) return { ran: false, why: "no gc", runs };
    if (a.busy) return { ran: false, why: "busy", runs };
    if (a.lastActiveAt <= this.ranAt) return { ran: false, why: "nothing new", runs };
    if (now - a.lastActiveAt < quietMs) return { ran: false, why: "recent", runs };
    const t = performance.now();
    this.gc({ type: "major", execution: "sync", flavor: "last-resort" });
    this.ranAt = now;
    this.runs++;
    return { ran: true, ms: Math.round(performance.now() - t), runs: this.runs };
  }
}
