// SPDX-License-Identifier: AGPL-3.0-or-later
// The idle GC. workerd gives V8 no idle time: its platform has idle tasks off and runs V8's memory reducer only at the
// end of a request, so heap that a burst of requests grew stays committed while Hewn sits idle (on Linux the
// platform's RSS settles near a small machine's size). The supervisor asks every few seconds (/_admin/idle-gc); one
// last-resort GC gives the heap back (25–100 ms) once the owner, their agents and the CLI have left Hewn alone a while.
// What reaches it on no one's behalf (an open page's refreshes, every 15 s; refused or anonymous requests) never
// leaves it quiet for long, so after only that it collects at most every few minutes. Only the platform's process has
// `gc` (its config's `--expose-gc`); the tools' never does.
import type { ActivityView } from "@hewntools/core/platform/activity.ts";

/** Quiet this long after the last work before the platform collects. */
export const IDLE_GC_QUIET_MS = 30_000;
/** With nothing but an open page's refreshes and the like since the last collection, one at most this often. */
export const IDLE_GC_BACKGROUND_EVERY_MS = 5 * 60_000;

export interface GcTiming {
  quietMs: number;
  backgroundEveryMs: number;
}

export type IdleGcAnswer = { ran: true; ms: number; runs: number } | { ran: false; why: "no gc" | "busy" | "recent" | "too soon" | "nothing new"; runs: number };

/** Admin calls that are the supervisor's own ticks and reads (the idle report, metrics, the disk): neither work nor background. */
export function tickCall(path: string, body: Record<string, unknown>): boolean {
  if (path === "/_admin/idle-gc" || path === "/_admin/disk") return true;
  return path === "/_admin/call" && ["idleActivity", "nextScheduleAt", "metrics"].includes(String(body.method));
}

/** One collection per quiet spell, from two clocks: work (the start counts) and background. */
export class IdleGc {
  private gc: ((o: object) => void) | undefined;
  private workAt = Date.now();
  private backgroundAt = 0;
  private ranAt = 0;
  private runs = 0;

  constructor(gc: ((o: object) => void) | undefined) {
    this.gc = gc;
  }

  /** Work the idle report doesn't see: the CLI's admin calls, a tool's callbacks, a schedule's alarm. */
  work(now = Date.now()) {
    this.workAt = now;
  }

  /** A request on no one's behalf: an open page's refresh, a refused or anonymous one. */
  background(now = Date.now()) {
    this.backgroundAt = now;
  }

  /**
   * Collect if it's time: nothing running (a build, an intake turn, a tool call), no work for `quietMs`, and work since
   * the last collection, or only background since and the last one `backgroundEveryMs` ago.
   */
  collectIfQuiet(a: ActivityView, running: boolean, t: GcTiming = { quietMs: IDLE_GC_QUIET_MS, backgroundEveryMs: IDLE_GC_BACKGROUND_EVERY_MS }, now = Date.now()): IdleGcAnswer {
    const runs = this.runs;
    if (!this.gc) return { ran: false, why: "no gc", runs };
    if (running || a.building || a.intakes > 0) return { ran: false, why: "busy", runs };
    const workAt = Math.max(this.workAt, ...[a.lastRequestAt, a.lastCallAt, a.lastStreamAt, a.lastIntakeAt, a.lastBuildAt].filter((x): x is number => x !== null));
    if (now - workAt < t.quietMs) return { ran: false, why: "recent", runs };
    if (workAt <= this.ranAt) {
      if (this.backgroundAt <= this.ranAt) return { ran: false, why: "nothing new", runs };
      if (now - this.ranAt < t.backgroundEveryMs) return { ran: false, why: "too soon", runs };
    }
    const started = performance.now();
    this.gc({ type: "major", execution: "sync", flavor: "last-resort" });
    this.ranAt = now;
    this.runs++;
    return { ran: true, ms: Math.round(performance.now() - started), runs: this.runs };
  }
}
