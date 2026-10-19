// SPDX-License-Identifier: AGPL-3.0-or-later
// Schedules: the owner's "run this operation on a timetable". Cadences are cron-like, evaluated
// in the owner's timezone. Pure: the host decides when to call Platform.runDueSchedules().
import { PlatformError } from "./errors.ts";
import type { Sql } from "./ports.ts";

export type ScheduleStatus = "proposed" | "active" | "paused";

export interface Schedule {
  id: string;
  capabilityId: string;
  operation: string;
  operationVersion: number;
  input: unknown;
  /** As entered: "hourly", "daily 07:30", "weekly mon 07:30", or a 5-field cron expression. */
  cadence: string;
  timezone: string;
  status: ScheduleStatus;
  createdBy: string;
  createdAt: string;
  nextRunAt: number | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  failures: number;
  pausedReason: string | null;
  note: string | null;
}

/** Consecutive failures that pause a schedule. */
export const MAX_FAILURES = 3;
/** Schedules may not run more often than this. */
export const MIN_INTERVAL_MS = 5 * 60_000;

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A cadence as a 5-field cron expression (minute hour day-of-month month day-of-week). */
export function toCron(cadence: string): string {
  const c = cadence.trim().toLowerCase();
  if (c === "hourly") return "0 * * * *";
  let m = /^daily (\d{1,2}):(\d{2})$/.exec(c);
  if (m) return `${Number(m[2])} ${Number(m[1])} * * *`;
  m = /^weekly (sun|mon|tue|wed|thu|fri|sat) (\d{1,2}):(\d{2})$/.exec(c);
  if (m) return `${Number(m[3])} ${Number(m[2])} * * ${DAYS.indexOf(m[1])}`;
  if (c.split(/\s+/).length === 5) return c;
  throw new PlatformError("invalid_request", `cadence must be "hourly", "daily HH:MM", "weekly mon HH:MM" or a 5-field cron expression (got "${cadence}")`);
}

type Field = Set<number> | "*";

function parseField(spec: string, min: number, max: number, name: string): Field {
  if (spec === "*") return "*";
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new PlatformError("invalid_request", `bad cron ${name} field "${spec}"`);
    const from = m[1] === "*" ? min : Number(m[2]);
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    const step = m[4] ? Number(m[4]) : 1;
    if (from < min || to > max || from > to || step < 1) throw new PlatformError("invalid_request", `cron ${name} out of range in "${spec}"`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

export function parseCron(expr: string): Cron {
  const [minute, hour, dom, month, dow] = expr.trim().split(/\s+/);
  return {
    minute: parseField(minute, 0, 59, "minute"),
    hour: parseField(hour, 0, 23, "hour"),
    dom: parseField(dom, 1, 31, "day-of-month"),
    month: parseField(month, 1, 12, "month"),
    dow: parseField(dow.replace(/\b7\b/g, "0"), 0, 6, "day-of-week"),
  };
}

const has = (f: Field, v: number) => f === "*" || f.has(v);

/** Wall-clock fields of an instant in a timezone. */
function local(ms: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { minute: Number(get("minute")), hour: Number(get("hour")) % 24, dom: Number(get("day")), month: Number(get("month")), dow: DAYS.indexOf(get("weekday").toLowerCase().slice(0, 3)) };
}

/** The first matching minute strictly after `after` (epoch ms), searching up to a year ahead. */
export function nextRun(cron: Cron, timezone: string, after: number): number {
  let t = Math.floor(after / 60_000) * 60_000 + 60_000;
  const end = after + 366 * 86400_000;
  while (t <= end) {
    const l = local(t, timezone);
    if (!has(cron.month, l.month) || !has(cron.hour, l.hour)) {
      // Skip to the next hour boundary (timezones with half-hour offsets still land on :00 locally after one minute step).
      t += (60 - l.minute) * 60_000;
      continue;
    }
    // Standard cron: if both day fields are restricted, either may match.
    const domOk = has(cron.dom, l.dom);
    const dowOk = has(cron.dow, l.dow);
    const dayOk = cron.dom !== "*" && cron.dow !== "*" ? domOk || dowOk : domOk && dowOk;
    if (dayOk && has(cron.minute, l.minute)) return t;
    t += 60_000;
  }
  throw new PlatformError("invalid_request", "this cadence never runs within a year");
}

/** Validate a cadence: parseable, and not more often than MIN_INTERVAL_MS. Returns the cron. */
export function checkCadence(cadence: string, timezone: string, now = Date.now()): Cron {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new PlatformError("invalid_request", `unknown timezone "${timezone}"`);
  }
  const cron = parseCron(toCron(cadence));
  let t = now;
  const runs: number[] = [];
  for (let i = 0; i < 4; i++) runs.push((t = nextRun(cron, timezone, t)));
  for (let i = 1; i < runs.length; i++) {
    if (runs[i] - runs[i - 1] < MIN_INTERVAL_MS) throw new PlatformError("invalid_request", `schedules run at most every ${MIN_INTERVAL_MS / 60_000} minutes`);
  }
  return cron;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, capability_id TEXT NOT NULL, operation TEXT NOT NULL, op_version INTEGER NOT NULL,
  input TEXT NOT NULL, cadence TEXT NOT NULL, timezone TEXT NOT NULL, status TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, next_run_at INTEGER, last_run_at TEXT,
  last_outcome TEXT, failures INTEGER NOT NULL DEFAULT 0, paused_reason TEXT, note TEXT)`;

const toSchedule = (r: Record<string, any>): Schedule => ({
  id: r.id,
  capabilityId: r.capability_id,
  operation: r.operation,
  operationVersion: Number(r.op_version),
  input: JSON.parse(r.input),
  cadence: r.cadence,
  timezone: r.timezone,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  nextRunAt: r.next_run_at === null || r.next_run_at === undefined ? null : Number(r.next_run_at),
  lastRunAt: r.last_run_at ?? null,
  lastOutcome: r.last_outcome ?? null,
  failures: Number(r.failures),
  pausedReason: r.paused_reason ?? null,
  note: r.note ?? null,
});

/** Schedule rows in the platform's database. */
export class ScheduleStore {
  private sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
    sql.exec(SCHEMA);
  }
  insert(s: Omit<Schedule, "lastRunAt" | "lastOutcome" | "failures" | "pausedReason">) {
    this.sql
      .prepare("INSERT INTO schedules (id, capability_id, operation, op_version, input, cadence, timezone, status, created_by, created_at, next_run_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(s.id, s.capabilityId, s.operation, s.operationVersion, JSON.stringify(s.input ?? {}), s.cadence, s.timezone, s.status, s.createdBy, s.createdAt, s.nextRunAt, s.note);
  }
  get(id: string): Schedule | undefined {
    const r = this.sql.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
    return r ? toSchedule(r) : undefined;
  }
  list(capabilityId?: string): Schedule[] {
    const rows = capabilityId ? this.sql.prepare("SELECT * FROM schedules WHERE capability_id = ? ORDER BY created_at").all(capabilityId) : this.sql.prepare("SELECT * FROM schedules ORDER BY created_at").all();
    return rows.map(toSchedule);
  }
  update(id: string, patch: Partial<Pick<Schedule, "status" | "nextRunAt" | "lastRunAt" | "lastOutcome" | "failures" | "pausedReason" | "cadence" | "input" | "timezone">>) {
    const cols: Record<string, string> = { status: "status", nextRunAt: "next_run_at", lastRunAt: "last_run_at", lastOutcome: "last_outcome", failures: "failures", pausedReason: "paused_reason", cadence: "cadence", input: "input", timezone: "timezone" };
    for (const [k, v] of Object.entries(patch)) this.sql.prepare(`UPDATE schedules SET ${cols[k]} = ? WHERE id = ?`).run(k === "input" ? JSON.stringify(v ?? {}) : (v ?? null), id);
  }
  delete(id: string) {
    this.sql.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }
  deleteFor(capabilityId: string) {
    this.sql.prepare("DELETE FROM schedules WHERE capability_id = ?").run(capabilityId);
  }
  /** Active schedules whose time has come. */
  due(now: number): Schedule[] {
    return this.sql.prepare("SELECT * FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at").all(now).map(toSchedule);
  }
  nextAt(): number | null {
    const r = this.sql.prepare("SELECT MIN(next_run_at) AS t FROM schedules WHERE status = 'active' AND next_run_at IS NOT NULL").get();
    return r?.t === null || r?.t === undefined ? null : Number(r.t);
  }
}
