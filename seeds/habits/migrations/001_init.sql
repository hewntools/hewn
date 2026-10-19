CREATE TABLE habits (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE check_ins (
  habit_id TEXT NOT NULL REFERENCES habits (id),
  date     TEXT NOT NULL,
  PRIMARY KEY (habit_id, date)
);
