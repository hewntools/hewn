CREATE TABLE notes_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX notes_person_date ON notes_log(person_id, date DESC, id DESC);
CREATE TABLE prepared_suggestions (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  suggestions TEXT NOT NULL,
  PRIMARY KEY(person_id, date)
);
