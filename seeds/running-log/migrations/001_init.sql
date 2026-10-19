CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  date             TEXT NOT NULL,
  distance_km      REAL NOT NULL,
  duration_seconds INTEGER NOT NULL,
  notes            TEXT,
  recorded_at      TEXT NOT NULL
);
CREATE INDEX runs_date ON runs (date);
