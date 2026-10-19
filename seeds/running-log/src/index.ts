// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Ctx = { db: DatabaseSync };
type Range = { from?: string; to?: string };
type RunRow = { id: string; date: string; distance_km: number; duration_seconds: number; notes: string | null };

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function where({ from, to }: Range): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (from) (clauses.push("date >= ?"), params.push(from));
  if (to) (clauses.push("date <= ?"), params.push(to));
  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

export const operations = {
  "record_run@1"(input: { distanceKm: number; durationSeconds: number; date?: string; notes?: string }, { db }: Ctx) {
    const runId = randomUUID();
    db.prepare(
      "INSERT INTO runs (id, date, distance_km, duration_seconds, notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(runId, input.date ?? today(), input.distanceKm, input.durationSeconds, input.notes ?? null, new Date().toISOString());
    return { runId };
  },

  "list_runs@1"(input: Range, { db }: Ctx) {
    const w = where(input);
    const rows = db
      .prepare(`SELECT id, date, distance_km, duration_seconds, notes FROM runs ${w.sql} ORDER BY date, recorded_at`)
      .all(...w.params) as RunRow[];
    return {
      runs: rows.map((r) => ({
        runId: r.id,
        date: r.date,
        distanceKm: r.distance_km,
        durationSeconds: r.duration_seconds,
        ...(r.notes !== null ? { notes: r.notes } : {}),
      })),
    };
  },

  "get_summary@1"(input: Range, { db }: Ctx) {
    const w = where(input);
    const r = db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(distance_km), 0) AS km, COALESCE(SUM(duration_seconds), 0) AS s FROM runs ${w.sql}`)
      .get(...w.params) as { n: number; km: number; s: number };
    return {
      runCount: r.n,
      totalDistanceKm: round(r.km, 2),
      totalDurationSeconds: r.s,
      averageDistanceKm: r.n ? round(r.km / r.n, 2) : null,
      averagePaceSecondsPerKm: r.km > 0 ? Math.round(r.s / r.km) : null,
    };
  },
};
