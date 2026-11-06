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
  /** Best hour of the dark window, or null when there is none (too light). */
  best_hour: BestHour | null;
  /** How bright the moon is, 0 (dark) to 1 (full), or null when not known. */
  moon_brightness: number | null;
  /** Short label for the moon brightness, or null when not known. */
  moon_label: string | null;
  /** Short verdict derived from the rating and moon, or null when not known. */
  verdict: string | null;
};

/** A stored row as the operations return it (writeNight is the only writer). */
export function toForecast(row: any): Forecast {
  return {
    ...row,
    kp_slots: JSON.parse(row.kp_slots),
    cloud_slots: JSON.parse(row.cloud_slots),
    best_hour: row.best_hour ? JSON.parse(row.best_hour) : null,
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
    f.fetched_at,
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
