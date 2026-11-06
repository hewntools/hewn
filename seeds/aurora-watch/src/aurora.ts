// SPDX-License-Identifier: Apache-2.0
// Pure logic: parsing upstream payloads, solar position, dark window, rating.
// No I/O here, so everything can be exercised offline with fixture JSON.

export type KpSlot = { time: string; kp: number };
export type CloudSlot = { time: string; pct: number };
export type DarkWindow = { start: string; end: string };
export type Rating = "none" | "low" | "possible" | "good";
/** Where the owner watches from: a name, coordinates and the place's time zone (IANA). */
export type Place = { name: string; latitude: number; longitude: number; timezone: string };

const MIN = 60_000;
const HOUR = 60 * MIN;
const RAD = Math.PI / 180;

// ---------- time helpers (the place's own time zone) ----------

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

type ZonedParts = { date: string; hour: number; minute: number; second: number };

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(tz: string): Intl.DateTimeFormat {
  let f = zoneFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    zoneFormats.set(tz, f);
  }
  return f;
}

/** Whether `tz` is a time zone this runtime knows (an IANA name such as "Europe/Oslo"). */
export function isTimeZone(tz: string): boolean {
  try {
    zoneFormat(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock date and time in `tz` at a UTC instant. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of zoneFormat(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function zoneOffset(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const [y, m, d] = p.date.split("-").map(Number);
  return Date.UTC(y, m - 1, d, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

export function localDate(ms: number, tz: string): string {
  return zonedParts(ms, tz).date;
}

export function localHHMM(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** 12:00 local on `date` in `tz`, as a UTC instant. */
function localNoonUTC(date: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 12);
  const guess = wall - zoneOffset(wall, tz);
  return wall - zoneOffset(guess, tz);
}

/**
 * Which night "tonight" is at `now`: the local date the evening starts, in the place's zone.
 * Normally the coming night (this evening into tomorrow morning). Only while it is
 * dark right now (sun below −12° at the place) in the morning hours, i.e. inside a dark
 * window that started the previous evening, is it still last night. A night that has
 * ended can't be forecast (MET Norway only covers from now on), so it never resolves
 * to one. Every operation that defaults the date uses this.
 */
export function resolveNight(now: number, place: Place): string {
  const p = zonedParts(now, place.timezone);
  // Dark windows are bounded by local noon (see darkWindow), so darkness before noon
  // belongs to the night that began yesterday evening.
  const darkNow = solarAltitude(now, place.latitude, place.longitude) < DARK_ALTITUDE;
  return darkNow && p.hour < 12 ? addDays(p.date, -1) : p.date;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "today 18:02", "yesterday 21:00" or "14 Dec 21:00", local time relative to now. */
export function fmtWhen(ms: number, nowMs: number, tz: string): string {
  const hhmm = localHHMM(ms, tz);
  const day = localDate(ms, tz);
  const today = localDate(nowMs, tz);
  if (day === today) return `today ${hhmm}`;
  if (day === addDays(today, -1)) return `yesterday ${hhmm}`;
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${hhmm}`;
}

export function isoMinute(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Accepts "2026-12-15 21:00:00", "2026-12-15T21:00:00" (both UTC) or a zoned ISO string. */
function toIsoUTC(s: string): string | null {
  let t = s.trim().replace(" ", "T");
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(t)) t += "Z";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? isoMinute(ms) : null;
}

// ---------- parsers ----------

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * NOAA planetary K-index forecast. Handles both the classic table format
 * ([["time_tag","kp","observed","noaa_scale"], ["2026-12-15 00:00:00","2.33",...], ...])
 * and the newer array-of-objects format ([{ time_tag, kp, ... }]).
 */
export function parseKp(noaaJson: unknown): KpSlot[] {
  if (!Array.isArray(noaaJson)) throw new Error("NOAA Kp forecast: expected a JSON array");
  const rows = noaaJson as unknown[];
  let timeIdx = 0;
  let kpIdx = 1;
  const out: KpSlot[] = [];
  rows.forEach((row, i) => {
    let time: unknown;
    let kp: unknown;
    if (Array.isArray(row)) {
      if (i === 0 && (row.includes("time_tag") || row.includes("kp"))) {
        const ti = row.indexOf("time_tag");
        const ki = row.indexOf("kp");
        if (ti >= 0) timeIdx = ti;
        if (ki >= 0) kpIdx = ki;
        return;
      }
      time = row[timeIdx];
      kp = row[kpIdx];
    } else if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      time = r.time_tag ?? r.time;
      kp = r.kp ?? r.Kp;
    } else return;
    const iso = typeof time === "string" ? toIsoUTC(time) : null;
    const k = num(kp);
    if (iso && k !== null) out.push({ time: iso, kp: k });
  });
  if (!out.length) throw new Error("NOAA Kp forecast had no usable rows");
  return out;
}

/** MET Norway locationforecast compact: cloud_area_fraction per timeseries entry. */
export function parseClouds(metJson: unknown): CloudSlot[] {
  const series = (metJson as any)?.properties?.timeseries;
  if (!Array.isArray(series)) throw new Error("MET Norway forecast: missing properties.timeseries");
  const out: CloudSlot[] = [];
  for (const e of series) {
    const iso = typeof e?.time === "string" ? toIsoUTC(e.time) : null;
    const pct = num(e?.data?.instant?.details?.cloud_area_fraction);
    if (iso && pct !== null) out.push({ time: iso, pct });
  }
  if (!out.length) throw new Error("MET Norway forecast had no cloud cover values");
  return out;
}

// ---------- sun ----------

/** Solar altitude in degrees at a UTC instant (low-precision almanac formulae, ~0.1°). */
export function solarAltitude(ms: number, lat: number, lon: number): number {
  const d = ms / 86_400_000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15; // degrees
  const ha = (gmst + lon) * RAD - ra;
  const phi = lat * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha)) / RAD;
}

export const DARK_ALTITUDE = -12;

/**
 * The night's dark window (sun below −12°) between local noon on `date` and
 * local noon the next day, or null when it never gets that dark (around midsummer).
 */
export function darkWindow(date: string, place: Place): DarkWindow | null {
  const from = localNoonUTC(date, place.timezone);
  const to = localNoonUTC(addDays(date, 1), place.timezone);
  let first: number | null = null;
  let last: number | null = null;
  for (let t = from; t <= to; t += MIN) {
    if (solarAltitude(t, place.latitude, place.longitude) < DARK_ALTITUDE) {
      if (first === null) first = t;
      last = t;
    }
  }
  if (first === null || last === null) return null;
  return { start: isoMinute(first), end: isoMinute(Math.min(last + MIN, to)) };
}

/** Whether a slot [time, time+duration) overlaps the window. */
export function overlaps(time: string, durationMs: number, w: DarkWindow): boolean {
  const t = Date.parse(time);
  return t < Date.parse(w.end) && t + durationMs > Date.parse(w.start);
}

export const KP_SLOT_MS = 3 * HOUR;
export const CLOUD_SLOT_MS = HOUR;

// ---------- how strong it has to be, from where ----------

// North geomagnetic pole of the centred dipole (IGRF, 2025): close enough for a rule of thumb.
const POLE_LAT = 80.8;
const POLE_LON = -72.6;

/** Geomagnetic latitude in degrees (centred dipole); negative in the southern hemisphere. */
export function geomagneticLatitude(lat: number, lon: number): number {
  const s = Math.sin(lat * RAD) * Math.sin(POLE_LAT * RAD) + Math.cos(lat * RAD) * Math.cos(POLE_LAT * RAD) * Math.cos((lon - POLE_LON) * RAD);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

const third = (x: number) => Math.round(x * 3) / 3;

/**
 * The Kp an aurora needs to be seen from a place, on the Kp scale (thirds). The auroral oval's
 * edge moves about 2° of geomagnetic latitude towards the equator per Kp step: "possible" once
 * it reaches the place, "good" a step and a third past it. Oslo (59.7° geomagnetic) needs Kp 3.67
 * for "possible"; Tromsø (67.5°) sits under the oval, so any Kp will do.
 */
export function kpNeeded(lat: number, lon: number): { possible: number; good: number } {
  const m = Math.abs(geomagneticLatitude(lat, lon));
  const possible = third(Math.min(9, Math.max(0, (67.2 - m) / 2)));
  return { possible, good: third(Math.min(9, possible + 4 / 3)) };
}

export function fmtKp(kp: number): string {
  return String(Number(kp.toFixed(2)));
}

export function rate(input: { kp_max: number | null; cloud_avg: number | null; dark: boolean; place: Place }): { rating: Rating; reason: string } {
  if (!input.dark) return { rating: "none", reason: "Too light: the sun never gets 12° below the horizon" };
  const need = kpNeeded(input.place.latitude, input.place.longitude);
  const kp = input.kp_max ?? 0;
  const cloud = input.cloud_avg ?? 100;
  const k = fmtKp(kp);
  const eps = 1e-9;
  if (cloud > 70) return { rating: "low", reason: `Clouded over (${cloud}% cloud)` };
  if (kp + eps >= need.good && cloud <= 40) return { rating: "good", reason: `Kp ${k} and mostly clear skies (${cloud}% cloud)` };
  if (kp + eps >= need.possible && cloud <= 60) return { rating: "possible", reason: `Kp ${k} with ${cloud}% cloud` };
  if (kp + eps >= need.possible) return { rating: "low", reason: `Too cloudy for Kp ${k} (${cloud}% cloud)` };
  return { rating: "low", reason: `Kp ${k} is too weak to reach ${input.place.name} (it needs about ${fmtKp(need.possible)})` };
}

export const RATING_WORD: Record<Rating, string> = {
  none: "Too light",
  low: "Low",
  possible: "Possible",
  good: "Good",
};

// ---------- moon ----------

// Mean synodic month (new moon to new moon), days.
const SYNODIC_MONTH = 29.530588853;
// A well-known new moon: 2000-01-06 18:14 UTC.
const KNOWN_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);

function moonAgeDays(ms: number): number {
  const days = (ms - KNOWN_NEW_MOON_MS) / 86_400_000;
  return ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH;
}

export type Moon = { brightness: number; label: string };

/** How bright the moon is at `ms`, 0 (new/dark) to 1 (full), from its phase alone (no network). */
export function moonBrightness(ms: number): Moon {
  const phase = moonAgeDays(ms) / SYNODIC_MONTH; // 0..1
  const brightness = Math.round(((1 - Math.cos(2 * Math.PI * phase)) / 2) * 100) / 100;
  let label: string;
  if (brightness <= 0.06) label = "new moon";
  else if (brightness <= 0.35) label = "crescent";
  else if (brightness <= 0.65) label = "half moon";
  else if (brightness <= 0.9) label = "gibbous";
  else label = "full moon";
  return { brightness, label };
}

// ---------- best hour ----------

export type BestHour = {
  start: string;
  end: string;
  start_local: string;
  end_local: string;
  kp: number | null;
  cloud_pct: number | null;
};

/**
 * Pick the best hour of the dark window: the highest Kp, tie-broken by the lowest
 * cloud cover. Uses the Kp and cloud slots, so it needs no network. Returns null
 * when there is no dark window or no slot covers it.
 */
export function bestHour(win: DarkWindow | null, kpSlots: KpSlot[], cloudSlots: CloudSlot[], tz: string): BestHour | null {
  if (!win) return null;
  const kp = kpSlots.filter((s) => overlaps(s.time, KP_SLOT_MS, win));
  const clouds = cloudSlots.filter((s) => overlaps(s.time, CLOUD_SLOT_MS, win));
  if (!kp.length && !clouds.length) return null;

  // Candidate starts: every slot boundary inside the window, from the window start.
  const startMs = Date.parse(win.start);
  const endMs = Date.parse(win.end);
  const candidates = new Set<number>([startMs]);
  for (const s of [...kp, ...clouds]) {
    const t = Date.parse(s.time);
    if (t >= startMs && t < endMs) candidates.add(t);
  }

  const at = <T extends { time: string }>(slots: T[], t: number, dur: number): T | undefined =>
    slots.find((s) => Date.parse(s.time) <= t && Date.parse(s.time) + dur > t);

  let best: { t: number; kp: number; cloud: number } | null = null;
  for (const t of [...candidates].sort((a, b) => a - b)) {
    if (t >= endMs) continue;
    const k = at(kp, t, KP_SLOT_MS);
    const c = at(clouds, t, CLOUD_SLOT_MS);
    if (!k && !c) continue;
    const kpVal = k ? k.kp : -1;
    const cloudVal = c ? c.pct : 101;
    if (best === null || kpVal > best.kp + 1e-9 || (Math.abs(kpVal - best.kp) <= 1e-9 && cloudVal < best.cloud)) {
      best = { t, kp: kpVal, cloud: cloudVal };
    }
  }
  if (best === null) return null;

  const bStart = best.t;
  const bKp = at(kp, bStart, KP_SLOT_MS);
  const bCloud = at(clouds, bStart, CLOUD_SLOT_MS);
  const bEnd = Math.min(bStart + HOUR, endMs);
  return {
    start: isoMinute(bStart),
    end: isoMinute(bEnd),
    start_local: localHHMM(bStart, tz),
    end_local: localHHMM(bEnd, tz),
    kp: bKp ? bKp.kp : null,
    cloud_pct: bCloud ? bCloud.pct : null,
  };
}

/** A short verdict derived from the rating and how bright the moon is. */
export function verdictFor(rating: Rating, moon: Moon | null): string {
  const bright = moon !== null && moon.brightness >= 0.6;
  switch (rating) {
    case "good":
      return bright ? "Worth a look, though the moon is bright" : "Worth looking tonight";
    case "possible":
      return bright ? "A chance, but the moon will wash it out" : "Keep an eye out tonight";
    case "low":
      return bright ? "Unlikely, and the moon is bright" : "Probably nothing tonight";
    default:
      return "Too light for aurora";
  }
}
