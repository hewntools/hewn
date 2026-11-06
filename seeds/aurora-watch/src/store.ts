// SPDX-License-Identifier: Apache-2.0
// The one place that reads and writes stored nights and the owner's place. fetch_tonight
// writes through writeNight; get_tonight, list_nights and the widget read through
// readNight/listNights, so they always agree on the key (night_date, YYYY-MM-DD local),
// the columns and the JSON fields.

import type { BestHour, CloudSlot, KpSlot, Place, Rating } from "./aurora.ts";

export type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): { changes: number; lastInsertRowid: number }; all(...p: unknown[]): any[]; get(...p: unknown[]): any };
  transaction<T>(fn: () => T): T;
};

export type Forecast = {
  night_date: string;
  fetched_at: string;
  dark_start: string | null;
  dark_end: string | null;
  kp_max: number | null;
  kp_slots: KpSlot[];
  cloud_avg_pct: number | null;
  cloud_slots: CloudSlot[];
  rating: Rating;
  reason: string;
  /** When the forecast was fetched (ISO), or null when an older record doesn't say. */
  fetchedAt: string | null;
  /** Best hour of the dark window, or null when not known (older records, no window). */
  best_hour: BestHour | null;
  /** How bright the moon is, 0 (dark) to 1 (full), or null when not known. */
  moon_brightness: number | null;
  /** Short label for the moon brightness, or null when not known. */
  moon_label: string | null;
  /** Short verdict derived from the rating and moon, or null when not known. */
  verdict: string | null;
};

function bestHourOf(v: unknown): BestHour | null {
  if (!v) return null;
  let obj: any = v;
  if (typeof v === "string") {
    try {
      obj = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || typeof obj.start !== "string" || typeof obj.end !== "string") return null;
  return {
    start: obj.start,
    end: obj.end,
    start_local: typeof obj.start_local === "string" ? obj.start_local : "",
    end_local: typeof obj.end_local === "string" ? obj.end_local : "",
    kp: numOrNull(obj.kp),
    cloud_pct: numOrNull(obj.cloud_pct),
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

const RATINGS: Rating[] = ["none", "low", "possible", "good"];

function slots<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v !== "string" || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A valid ISO timestamp, or null (missing, empty or unparseable means unknown). */
export function fetchedAtOf(v: unknown): string | null {
  return typeof v === "string" && v && Number.isFinite(Date.parse(v)) ? v : null;
}

/** Map a stored row (or a record of the same shape) to a Forecast, tolerating older records. */
export function toForecast(row: any): Forecast {
  const fetchedAt = fetchedAtOf(row.fetched_at ?? row.fetchedAt);
  return {
    night_date: String(row.night_date),
    fetched_at: fetchedAt ?? "",
    dark_start: row.dark_start || null,
    dark_end: row.dark_end || null,
    kp_max: numOrNull(row.kp_max),
    kp_slots: slots<KpSlot>(row.kp_slots),
    cloud_avg_pct: numOrNull(row.cloud_avg_pct),
    cloud_slots: slots<CloudSlot>(row.cloud_slots),
    rating: RATINGS.includes(row.rating) ? row.rating : "low",
    reason: typeof row.reason === "string" ? row.reason : "",
    fetchedAt,
    best_hour: bestHourOf(row.best_hour),
    moon_brightness: numOrNull(row.moon_brightness),
    moon_label: strOrNull(row.moon_label),
    verdict: strOrNull(row.verdict),
  };
}

export function readPlace(db: Db): Place | null {
  const row = db.prepare("SELECT name, latitude, longitude, timezone FROM place WHERE id = 1").get();
  return row ? { name: row.name, latitude: row.latitude, longitude: row.longitude, timezone: row.timezone } : null;
}

export function writePlace(db: Db, p: Place): void {
  db.prepare(
    `INSERT INTO place (id, name, latitude, longitude, timezone) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, latitude = excluded.latitude,
       longitude = excluded.longitude, timezone = excluded.timezone`,
  ).run(p.name, p.latitude, p.longitude, p.timezone);
}

/** Moving: the nights rated for the old place, and the cached answers that carry its coordinates (MET Norway's URLs). */
export function forgetPlace(db: Db): void {
  db.prepare("DELETE FROM forecasts").run();
  db.prepare("DELETE FROM http_cache WHERE url LIKE 'https://api.met.no/%'").run();
}

/** The latest nights first, at most `limit` (1–60). */
export function listNights(db: Db, limit: number): Forecast[] {
  const n = Math.max(1, Math.min(60, Math.floor(limit)));
  return db.prepare("SELECT * FROM forecasts ORDER BY night_date DESC LIMIT ?").all(n).map(toForecast);
}

export function readNight(db: Db, date: string): Forecast | null {
  const row = db.prepare("SELECT * FROM forecasts WHERE night_date = ?").get(date);
  return row ? toForecast(row) : null;
}

export function writeNight(db: Db, f: Forecast): void {
  db.prepare(
    `INSERT INTO forecasts (night_date, fetched_at, dark_start, dark_end, kp_max, kp_slots, cloud_avg_pct, cloud_slots, rating, reason, best_hour, moon_brightness, moon_label, verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(night_date) DO UPDATE SET fetched_at = excluded.fetched_at, dark_start = excluded.dark_start,
       dark_end = excluded.dark_end, kp_max = excluded.kp_max, kp_slots = excluded.kp_slots,
       cloud_avg_pct = excluded.cloud_avg_pct, cloud_slots = excluded.cloud_slots,
       rating = excluded.rating, reason = excluded.reason, best_hour = excluded.best_hour,
       moon_brightness = excluded.moon_brightness, moon_label = excluded.moon_label, verdict = excluded.verdict`,
  ).run(
    f.night_date,
    f.fetchedAt ?? f.fetched_at,
    f.dark_start,
    f.dark_end,
    f.kp_max,
    JSON.stringify(f.kp_slots),
    f.cloud_avg_pct,
    JSON.stringify(f.cloud_slots),
    f.rating,
    f.reason,
    f.best_hour ? JSON.stringify(f.best_hour) : null,
    f.moon_brightness,
    f.moon_label,
    f.verdict,
  );
}
