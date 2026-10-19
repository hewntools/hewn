CREATE TABLE books (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  author      TEXT,
  status      TEXT NOT NULL CHECK (status IN ('want', 'reading', 'finished')),
  pages       INTEGER,
  page        INTEGER NOT NULL DEFAULT 0,
  rating      INTEGER,
  finished_on TEXT,
  added_at    TEXT NOT NULL
);
CREATE INDEX books_status ON books (status);
