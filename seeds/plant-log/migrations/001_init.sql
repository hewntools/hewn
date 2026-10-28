CREATE TABLE plants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  species TEXT,
  location TEXT,
  water_every_days INTEGER NOT NULL DEFAULT 7 CHECK (water_every_days >= 1),
  feed_every_days INTEGER CHECK (feed_every_days IS NULL OR feed_every_days >= 1),
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('watered', 'fed', 'repotted', 'note')),
  date TEXT NOT NULL,
  text TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX events_by_plant ON events (plant_id, type, date);
