// SPDX-License-Identifier: AGPL-3.0-or-later
// The idle report: whether Hewn is idle and when it next needs to be awake, for a host that suspends an idle Hewn
// and wakes it for its next alarm. Pulled (GET /status on the metrics port, `hewn status`), never sent: the host
// decides and acts, and Hewn never suspends itself.
import type { ActivityView } from "@hewntools/core/platform/activity.ts";

/** Why Hewn isn't idle (each reason a fixed word, never a name). */
export const BUSY_REASONS = ["starting", "request", "call", "build", "intake", "stream", "backup", "alarm-soon"] as const;
export type BusyReason = (typeof BUSY_REASONS)[number];

/** Quiet this long (no request, call or stream write) before Hewn says it's idle, unless the host asks for another time. */
export const IDLE_AFTER_SECONDS = 600;
/** After a start or a resume, Hewn stays awake this long whatever the host's quiet time: a woken Hewn isn't put back to sleep at once. */
export const GRACE_MS = 600_000;
/** A schedule due this soon keeps Hewn awake. */
export const ALARM_SOON_MS = 120_000;

export interface IdleStatus {
  idle: boolean;
  /** When the last activity ended (null while a build or an intake turn runs): a host may apply its own idle time. */
  since: string | null;
  busy: BusyReason[];
  /** The next schedule's run, or null. The backup is never an alarm. */
  nextAlarmAt: string | null;
  backup: { lastAt: string | null; changedSince: boolean };
  lastRequestAt: string | null;
  lastCallAt: string | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/**
 * Idle means every reason is clear: 10 minutes since Hewn started or resumed (`resumedAt`, the supervisor's), no
 * request, tool call or stream write for `afterSeconds`, no build running, no intake turn in flight, no change waiting
 * for today's backup, and no schedule due within 2 minutes.
 * `backup.lastAt` is the newest backup's time (any backup), `backedUpToday` whether one was made today.
 */
export function idleStatus(a: ActivityView, backup: { lastAt: number | null; backedUpToday: boolean }, now = Date.now(), afterSeconds = IDLE_AFTER_SECONDS, resumedAt: number | null = null): IdleStatus {
  const woke = Math.max(a.startedAt, resumedAt ?? 0);
  const recent = (t: number | null) => t !== null && now - t < afterSeconds * 1000;
  const changedSince = a.changedAt !== null && (backup.lastAt === null || a.changedAt > backup.lastAt);
  const reasons: Record<BusyReason, boolean> = {
    starting: now - woke < GRACE_MS,
    request: recent(a.lastRequestAt),
    call: recent(a.lastCallAt),
    build: a.building,
    intake: a.intakes > 0,
    stream: recent(a.openStreamAt),
    backup: changedSince && !backup.backedUpToday,
    "alarm-soon": a.nextAlarmAt !== null && a.nextAlarmAt - now <= ALARM_SOON_MS,
  };
  const busy = BUSY_REASONS.filter((r) => reasons[r]);
  const ended = Math.max(woke, ...[a.lastRequestAt, a.lastCallAt, a.lastStreamAt, a.lastIntakeAt, a.lastBuildAt].filter((t): t is number => t !== null));
  return {
    idle: busy.length === 0,
    since: a.building || a.intakes > 0 ? null : iso(ended),
    busy,
    nextAlarmAt: iso(a.nextAlarmAt),
    backup: { lastAt: iso(backup.lastAt), changedSince },
    lastRequestAt: iso(a.lastRequestAt),
    lastCallAt: iso(a.lastCallAt),
  };
}

/** `?after=<seconds>`: the host's own quiet time (whole seconds, up to a day), else the default. */
export function afterParam(v: string | null): number {
  const n = Number(v);
  return v !== null && v !== "" && Number.isInteger(n) && n >= 0 && n <= 86_400 ? n : IDLE_AFTER_SECONDS;
}

/** The line `hewn status` shows: "Idle since 14:02 · next alarm 06:00", or what keeps it busy. */
export function idleLine(s: IdleStatus, time = (t: string) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })): string {
  const head = s.idle ? `Idle${s.since ? ` since ${time(s.since)}` : ""}` : `Busy: ${s.busy.join(", ")}`;
  const alarm = s.nextAlarmAt ? ` · next alarm ${time(s.nextAlarmAt)}` : " · no alarm";
  return `${head}${alarm}${s.backup.changedSince ? " · changes since the last backup" : ""}`;
}
