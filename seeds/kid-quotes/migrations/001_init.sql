CREATE TABLE kids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  birthdate TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id INTEGER NOT NULL REFERENCES kids(id),
  text TEXT NOT NULL,
  context TEXT,
  said_on TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX quotes_said_on ON quotes(said_on);
CREATE INDEX quotes_kid ON quotes(kid_id);

-- One row: the quote the Home widget shows.
CREATE TABLE widget_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_quote_id INTEGER,
  shown_at TEXT
);

-- Which quotes the widget showed on which day, so an on-this-day quote is shown once a day.
CREATE TABLE widget_shown (
  quote_id INTEGER NOT NULL,
  shown_on TEXT NOT NULL,
  PRIMARY KEY (quote_id, shown_on)
);
