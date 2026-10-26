CREATE TABLE people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relation TEXT,
  birthday TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  idea TEXT NOT NULL,
  link TEXT,
  price REAL,
  occasion TEXT NOT NULL CHECK (occasion IN ('birthday', 'christmas', 'other')),
  year INTEGER,
  status TEXT NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'bought', 'given')),
  created_at TEXT NOT NULL,
  given_at TEXT
);

CREATE INDEX gifts_person ON gifts(person_id, status);

CREATE TABLE occasions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX occasions_person ON occasions(person_id);
