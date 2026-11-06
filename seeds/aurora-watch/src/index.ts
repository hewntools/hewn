// SPDX-License-Identifier: Apache-2.0
import {
  CLOUD_SLOT_MS,
  KP_SLOT_MS,
  RATING_WORD,
  bestHour,
  darkWindow,
  fmtKp,
  fmtWhen,
  geomagneticLatitude,
  isTimeZone,
  isoMinute,
  kpNeeded,
  localHHMM,
  moonBrightness,
  overlaps,
  parseClouds,
  parseKp,
  rate,
  resolveNight,
  verdictFor,
  type DarkWindow,
  type Place,
} from "./aurora.ts";
import { forgetPlace, listNights, readNight, readPlace, writeNight, writePlace, type Db, type Forecast } from "./store.ts";

type Ctx = { db: Db };

const NOAA_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json";
// MET Norway asks for coordinates of at most four decimals; two (about a kilometre) is plenty here.
const metUrl = (p: Place) => `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${p.latitude.toFixed(2)}&lon=${p.longitude.toFixed(2)}`;
// MET Norway's terms ask every client to say who it is.
const USER_AGENT = "hewn-aurora-watch/1 (+https://github.com/hewntools/hewn)";
const MIN_FETCH_INTERVAL_MS = 30 * 60_000;
const NO_PLACE = "No place set yet: choose where you watch from with set_place";

// ---------- clock and place ----------

/** The instant to evaluate at: the optional `now` input (replays and tests), else the current time. */
function clock(input: { now?: string } | undefined): number {
  if (input?.now === undefined) return Date.now();
  const ms = Date.parse(input.now);
  if (!Number.isFinite(ms)) throw new Error(`now must be an ISO timestamp, got "${input.now}"`);
  return ms;
}

function placeOrThrow(db: Db): Place {
  const p = readPlace(db);
  if (!p) throw new Error(NO_PLACE);
  return p;
}

/** The place as the operations return it: with how strong an aurora has to be to be seen there. */
function placeView(p: Place) {
  const need = kpNeeded(p.latitude, p.longitude);
  return {
    ...p,
    geomagnetic_latitude: Math.round(geomagneticLatitude(p.latitude, p.longitude) * 10) / 10,
    kp_possible: Number(fmtKp(need.possible)),
    kp_good: Number(fmtKp(need.good)),
  };
}

/** The part of the dark window from `now` on, when `now` falls inside it; else the whole window. */
function remainingWindow(win: DarkWindow, now: number): DarkWindow {
  const s = Date.parse(win.start);
  const e = Date.parse(win.end);
  return now > s && now < e ? { start: isoMinute(now), end: win.end } : win;
}

// ---------- upstream fetching with a per-URL cache ----------

async function fetchJson(db: Db, url: string, label: string): Promise<unknown> {
  const row = db.prepare("SELECT * FROM http_cache WHERE url = ?").get(url);
  const now = Date.now();
  if (row) {
    const recent = now - Date.parse(row.fetched_at) < MIN_FETCH_INTERVAL_MS;
    const unexpired = row.expires && now < Date.parse(row.expires);
    if (recent || unexpired) return JSON.parse(row.body);
  }

  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
  if (row?.last_modified) headers["If-Modified-Since"] = row.last_modified;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new Error(`${label} is unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }

  const expiresHeader = res.headers.get("expires");
  const expiresMs = expiresHeader ? Date.parse(expiresHeader) : NaN;
  const expires = Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null;

  if (res.status === 304 && row) {
    db.prepare("UPDATE http_cache SET fetched_at = ?, expires = ? WHERE url = ?").run(new Date(now).toISOString(), expires, url);
    return JSON.parse(row.body);
  }
  if (!res.ok) {
    const hint = res.status === 403 ? " (is the host approved?)" : "";
    throw new Error(`${label} returned HTTP ${res.status}${hint}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned something that isn't JSON`);
  }
  db.prepare(
    `INSERT INTO http_cache (url, fetched_at, expires, last_modified, body) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET fetched_at = excluded.fetched_at, expires = excluded.expires,
       last_modified = excluded.last_modified, body = excluded.body`,
  ).run(url, new Date(now).toISOString(), expires, res.headers.get("last-modified"), text);
  return json;
}

// ---------- widget ----------

// Small (about 86 px inside) holds the rating word, a one-line caption of a few characters
// under a short word, and the button row.
const SMALL_CAPTION_MAX = 10;

function smallCaption(word: string, options: string[]): string | undefined {
  if (word.length > 4) return undefined;
  return options.find((c) => c.length <= SMALL_CAPTION_MAX);
}

/** "crescent moon (18%)", "full moon (98%)". */
function moonText(brightness: number | null, label: string | null): string | null {
  const pct = brightness !== null ? Math.round(brightness * 100) : null;
  if (label) return `${label.endsWith("moon") ? label : `${label} moon`}${pct !== null ? ` (${pct}%)` : ""}`;
  return pct !== null ? `${pct}% moon` : null;
}

export function widgetView(place: Place | null, f: Forecast | null, nowMs: number, date?: string) {
  if (!place) {
    return {
      small: { template: "text", text: "Choose your place" },
      large: { template: "text", text: "Choose where you watch from in Aurora Watch, and it rates each night's chances there." },
    };
  }
  const tz = place.timezone;
  const buttons = [{ label: "Refresh", operation: "fetch_tonight@1", input: date ? { date } : {} }];
  if (!f) {
    // Nothing fetched for the night yet: what is known without the network (darkness, moon).
    const night = date ?? resolveNight(nowMs, place);
    const win = darkWindow(night, place);
    const moon = moonBrightness(Date.parse(`${night}T22:00:00Z`));
    return {
      small: { template: "text", text: "Not fetched yet", buttons },
      large: {
        template: "list",
        items: [
          { title: "Tonight", value: "Not fetched", detail: "Refresh for Kp and cloud" },
          { title: "Dark", value: win ? `${localHHMM(Date.parse(win.start), tz)}–${localHHMM(Date.parse(win.end), tz)}` : "Too light" },
          { title: "Moon", value: moonText(moon.brightness, moon.label)! },
          { title: "Place", value: place.name },
        ],
        buttons,
      },
    };
  }

  const fetchedMs = f.fetchedAt ? Date.parse(f.fetchedAt) : NaN;
  const known = Number.isFinite(fetchedMs);
  const fetchedRow = { title: "Fetched", value: known ? fmtWhen(fetchedMs, nowMs, tz) : "unknown", detail: place.name };

  if (!f.dark_start || !f.dark_end) {
    return {
      small: { template: "stat", value: RATING_WORD.none, buttons },
      large: { template: "list", items: [{ title: RATING_WORD.none, detail: "No dark window tonight" }, fetchedRow], buttons },
    };
  }

  const word = RATING_WORD[f.rating];
  const cloud = f.cloud_avg_pct !== null ? `${Math.round(f.cloud_avg_pct)}%` : "–";
  const hhmm = known ? localHHMM(fetchedMs, tz) : null;
  const best = f.best_hour;
  const bestLine = best ? `best ${best.start_local}` : null;
  // The compact caption (cloud, then fetched time); the best hour only when there is no cloud number.
  const options = [
    ...(f.cloud_avg_pct !== null ? [...(hhmm ? [`${cloud} cloud · fetched ${hhmm}`, `${cloud} · fetched ${hhmm}`] : []), `${cloud} cloud`] : []),
    ...(bestLine ? [bestLine] : []),
  ];
  const caption = smallCaption(word, options);
  const small = { template: "stat", value: word, ...(caption ? { caption } : {}), buttons };

  // The large card fits five rows. The rating and its verdict share the first row;
  // moon and the best hour are carried as row details so every fact fits.
  const moon = moonText(f.moon_brightness, f.moon_label);
  const bestDetail = best
    ? `best ${best.start_local}–${best.end_local}` + (best.kp !== null && best.cloud_pct !== null ? ` · Kp ${fmtKp(best.kp)}, ${Math.round(best.cloud_pct)}% cloud` : "")
    : undefined;
  const items = [
    { title: "Tonight", value: word, ...(f.verdict ? { detail: f.verdict } : {}) },
    { title: "Kp max", value: f.kp_max !== null ? fmtKp(f.kp_max) : "–" },
    { title: "Cloud", value: cloud, ...(moon ? { detail: moon } : {}) },
    { title: "Dark", value: `${localHHMM(Date.parse(f.dark_start), tz)}–${localHHMM(Date.parse(f.dark_end), tz)}`, ...(bestDetail ? { detail: bestDetail } : {}) },
    fetchedRow,
  ];
  return { small, large: { template: "list", items, buttons } };
}

// ---------- operations ----------

type NightInput = { date?: string; now?: string };

/** Everything wrong with a place, each said plainly; empty when it's fine. */
export function placeProblems(input: { name?: unknown; latitude?: unknown; longitude?: unknown; timezone?: unknown }): string[] {
  const out: string[] = [];
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) out.push("Give the place a name, e.g. Tromsø");
  else if (name.length > 60) out.push(`The name is ${name.length} characters long: keep it to 60`);
  const lat = input.latitude;
  if (typeof lat !== "number" || !Number.isFinite(lat)) out.push("Latitude needs a number in decimal degrees, e.g. 69.65");
  else if (lat < -90 || lat > 90) out.push(`Latitude must be between -90 and 90 (north is positive), not ${lat}`);
  const lon = input.longitude;
  if (typeof lon !== "number" || !Number.isFinite(lon)) out.push("Longitude needs a number in decimal degrees, e.g. 18.96");
  else if (lon < -180 || lon > 180) out.push(`Longitude must be between -180 and 180 (east is positive), not ${lon}`);
  const tz = typeof input.timezone === "string" ? input.timezone.trim() : "";
  if (!tz) out.push("Choose the place's time zone, e.g. Europe/Oslo");
  else if (tz.length > 64 || !isTimeZone(tz)) out.push(`Unknown time zone "${tz}": use a name such as Europe/Oslo or America/Anchorage`);
  return out;
}

export const operations = {
  "set_place@1": (input: { name: string; latitude: number; longitude: number; timezone: string }, ctx: Ctx) => {
    const problems = placeProblems(input);
    if (problems.length) throw new Error(problems.join(". "));
    const name = String(input.name).trim();
    const { latitude, longitude } = input;
    const place: Place = { name, latitude, longitude, timezone: String(input.timezone).trim() };
    const before = readPlace(ctx.db);
    ctx.db.transaction(() => {
      // Nights fetched for somewhere else say nothing about the new place, and the old place's coordinates go with them.
      if (before && (before.latitude !== latitude || before.longitude !== longitude)) forgetPlace(ctx.db);
      writePlace(ctx.db, place);
    });
    return placeView(place);
  },

  "get_place@1": (_input: unknown, ctx: Ctx) => {
    const p = readPlace(ctx.db);
    return p ? placeView(p) : null;
  },

  "fetch_tonight@1": async (input: NightInput & { noaa?: unknown; met?: unknown; quiet?: boolean }, ctx: Ctx) => {
    input = input ?? {};
    if (!input.quiet) return fetchTonight(input, ctx);
    // Quiet: a page opening offline (or before the hosts are approved) gets null, not an error.
    // The stored forecast stays as it was; the reason goes to the owner's logs.
    try {
      return await fetchTonight(input, ctx);
    } catch (e) {
      console.log(`fetch_tonight (quiet) fetched nothing: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  },

  "get_tonight@1": (input: NightInput, ctx: Ctx): Forecast | null => {
    input = input ?? {};
    const place = readPlace(ctx.db);
    if (!place) return null;
    return readNight(ctx.db, input.date ?? resolveNight(clock(input), place));
  },

  "list_nights@1": (input: { limit?: number }, ctx: Ctx) => {
    return { nights: listNights(ctx.db, input?.limit ?? 14) };
  },

  "dark_window@1": (input: NightInput, ctx: Ctx) => darkWindowOp(input, ctx),

  "widget_aurora@1": (input: NightInput, ctx: Ctx) => {
    // Only the resolved night's record counts; an older night shows what's known offline.
    input = input ?? {};
    const place = readPlace(ctx.db);
    const now = clock(input);
    if (!place) return widgetView(null, null, now, input.date);
    return widgetView(place, readNight(ctx.db, input.date ?? resolveNight(now, place)), now, input.date);
  },
};

async function fetchTonight(input: NightInput & { noaa?: unknown; met?: unknown }, ctx: Ctx): Promise<Forecast | null> {
  const place = readPlace(ctx.db);
  // A schedule may run before a place is chosen: nothing to fetch, and nothing wrong.
  if (!place) return null;
  const now = clock(input);
  const date = input.date ?? resolveNight(now, place);
  const win = darkWindow(date, place);
  const fetchedAt = isoMinute(now);
  const moon = moonBrightness(Date.parse(`${date}T22:00:00Z`));

  let forecast: Forecast;
  if (!win) {
    // Light all night: nothing upstream can change the answer, so don't fetch.
    const rating = rate({ kp_max: null, cloud_avg: null, dark: false, place });
    forecast = {
      night_date: date,
      fetched_at: fetchedAt,
      dark_start: null,
      dark_end: null,
      kp_max: null,
      kp_slots: [],
      cloud_avg_pct: null,
      cloud_slots: [],
      ...rating,
      fetchedAt,
      best_hour: null,
      moon_brightness: moon.brightness,
      moon_label: moon.label,
      verdict: verdictFor(rating.rating, moon),
    };
  } else {
    // Any failure here throws before the upsert, so a stored good record survives.
    const noaaJson = input.noaa ?? (await fetchJson(ctx.db, NOAA_URL, "NOAA SWPC"));
    const metJson = input.met ?? (await fetchJson(ctx.db, metUrl(place), "MET Norway"));
    // A night already in progress is rated on what's left of it: MET only forecasts from
    // now on, so the past part of the window can't (and needn't) be covered.
    const remaining = remainingWindow(win, now);
    const which = remaining === win ? "the night" : "the rest of the night";
    const kpSlots = parseKp(noaaJson).filter((s) => overlaps(s.time, KP_SLOT_MS, remaining));
    const cloudSlots = parseClouds(metJson).filter((s) => overlaps(s.time, CLOUD_SLOT_MS, remaining));
    if (!kpSlots.length) throw new Error(`NOAA's Kp forecast doesn't cover ${which} of ${date}`);
    if (!cloudSlots.length) throw new Error(`MET Norway's forecast doesn't cover ${which} of ${date}`);
    const kpMax = Math.max(...kpSlots.map((s) => s.kp));
    const cloudAvg = Math.round(cloudSlots.reduce((a, s) => a + s.pct, 0) / cloudSlots.length);
    const rating = rate({ kp_max: kpMax, cloud_avg: cloudAvg, dark: true, place });
    forecast = {
      night_date: date,
      fetched_at: fetchedAt,
      dark_start: win.start,
      dark_end: win.end,
      kp_max: kpMax,
      kp_slots: kpSlots,
      cloud_avg_pct: cloudAvg,
      cloud_slots: cloudSlots,
      ...rating,
      fetchedAt,
      best_hour: bestHour(remaining, kpSlots, cloudSlots, place.timezone),
      moon_brightness: moon.brightness,
      moon_label: moon.label,
      verdict: verdictFor(rating.rating, moon),
    };
  }
  writeNight(ctx.db, forecast);
  return forecast;
}

function darkWindowOp(input: NightInput, ctx: Ctx) {
  input = input ?? {};
  const place = placeOrThrow(ctx.db);
  const date = input.date ?? resolveNight(clock(input), place);
  const win = darkWindow(date, place);
  const moon = moonBrightness(Date.parse(`${date}T22:00:00Z`));
  const moonFields = { moon_brightness: moon.brightness, moon_label: moon.label };
  if (!win) {
    return { date, dark: false, dark_start: null, dark_end: null, dark_start_local: null, dark_end_local: null, dark_hours: 0, ...moonFields };
  }
  const s = Date.parse(win.start);
  const e = Date.parse(win.end);
  return {
    date,
    dark: true,
    dark_start: win.start,
    dark_end: win.end,
    dark_start_local: localHHMM(s, place.timezone),
    dark_end_local: localHHMM(e, place.timezone),
    dark_hours: Math.round((e - s) / 3_600_000),
    ...moonFields,
  };
}

