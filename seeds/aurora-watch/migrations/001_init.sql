-- Where the owner watches from: one row, set with set_place.
CREATE TABLE place (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  name      TEXT NOT NULL,
  latitude  REAL NOT NULL,
  longitude REAL NOT NULL,
  timezone  TEXT NOT NULL      -- IANA name; nights and times are local to it
);

CREATE TABLE forecasts (
  night_date      TEXT PRIMARY KEY,   -- local date the evening starts, in the place's time zone
  fetched_at      TEXT NOT NULL,
  dark_start      TEXT,               -- UTC ISO; null when it never gets dark
  dark_end        TEXT,
  kp_max          REAL,
  kp_slots        TEXT NOT NULL DEFAULT '[]',   -- JSON [{time, kp}]
  cloud_avg_pct   REAL,
  cloud_slots     TEXT NOT NULL DEFAULT '[]',   -- JSON [{time, pct}]
  rating          TEXT NOT NULL,
  reason          TEXT NOT NULL,
  best_hour       TEXT,               -- JSON {start, end, start_local, end_local, kp, cloud_pct}
  moon_brightness REAL,
  moon_label      TEXT,
  verdict         TEXT
);

-- Last upstream response per URL, so we honour Expires / If-Modified-Since
-- and never hit a source more than once per 30 minutes.
CREATE TABLE http_cache (
  url           TEXT PRIMARY KEY,
  fetched_at    TEXT NOT NULL,
  expires       TEXT,
  last_modified TEXT,
  body          TEXT NOT NULL
);
