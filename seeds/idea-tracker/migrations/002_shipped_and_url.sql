-- Adds the 'shipped' status and a nullable url column.
-- SQLite cannot change a CHECK constraint in place and migrations may not remove
-- tables, so the original tables are renamed to *_v1 (left as an untouched archive)
-- and rebuilt. Every row is copied verbatim with its rowid; url starts NULL.

ALTER TABLE notes RENAME TO notes_v1;
ALTER TABLE idea_tags RENAME TO idea_tags_v1;
ALTER TABLE ideas RENAME TO ideas_v1;

CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  pitch TEXT,
  status TEXT NOT NULL DEFAULT 'raw' CHECK (status IN ('raw', 'exploring', 'validating', 'parked', 'killed', 'shipped')),
  rating INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  note_seq INTEGER NOT NULL DEFAULT 0,
  url TEXT CHECK (url IS NULL OR length(url) <= 500)
);

CREATE INDEX ideas_by_status ON ideas (status);
CREATE INDEX ideas_by_updated ON ideas (updated_at);

CREATE TABLE idea_tags (
  idea_id TEXT NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (idea_id, tag)
);

CREATE INDEX idea_tags_by_tag ON idea_tags (tag);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX notes_by_idea ON notes (idea_id, created_at);

INSERT INTO ideas (rowid, id, title, pitch, status, rating, created_at, updated_at, status_changed_at, note_seq, url)
  SELECT rowid, id, title, pitch, status, rating, created_at, updated_at, status_changed_at, note_seq, NULL FROM ideas_v1;

INSERT INTO idea_tags (rowid, idea_id, tag)
  SELECT rowid, idea_id, tag FROM idea_tags_v1;

INSERT INTO notes (rowid, id, idea_id, body, created_at)
  SELECT rowid, id, idea_id, body, created_at FROM notes_v1;
