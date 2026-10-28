CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  pitch TEXT,
  status TEXT NOT NULL DEFAULT 'raw' CHECK (status IN ('raw', 'exploring', 'validating', 'parked', 'killed')),
  rating INTEGER CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  note_seq INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX ideas_status ON ideas (status);
CREATE INDEX ideas_updated ON ideas (updated_at);

CREATE TABLE idea_tags (
  idea_id TEXT NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (idea_id, tag)
);

CREATE INDEX idea_tags_tag ON idea_tags (tag);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX notes_idea ON notes (idea_id, created_at);
