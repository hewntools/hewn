Runtime: node. No network, no model, no secrets, no connections.

STATE (SQLite)
- books: id, title (required), author (optional), pages (optional integer), status (want | reading | finished | abandoned; default want), rating (integer 1–5, only for finished books), started_on and finished_on (local YYYY-MM-DD), progress_page (optional integer while reading), tags (list of short strings), note (optional short text), created_at.
- goals: year, target (number of books to finish that year).

RULES
- Setting status to reading fills started_on with today when it's empty; finished fills finished_on with today when it's empty. Both dates can also be given explicitly (back-dating).
- rating only on finished books; progress_page between 0 and pages when pages is known.

OPERATIONS (all @1)
- add_book (write): {title, author?, pages?, status?, tags?, note?, started_on?, finished_on?, rating?} → book.
- update_book (write): {id, any of the book fields} → book.
- update_progress (write): {id, page} → book (reading books only).
- delete_book (destructive): {id} → {deleted: true}.
- list_books (read): {status?, tag?, year?} → books (reading first by latest activity, then want by when added, then finished newest first), and the distinct tags with counts.
- year_stats (read): {year?, today?} → {year, finished_count, goal, expected_by_today (goal × share of the year gone), ahead_by (finished_count − expected_by_today, rounded), pages_read, avg_rating, by_month: [{month (1–12), count}], top_tags, longest_book}. Takes an optional `today` for tests.
- set_goal (write): {year, target} → goal.

TESTS
- Status changes fill dates, explicit dates win; rating only when finished; progress bounds; year_stats at the start, middle and end of a year and with no goal; by_month with empty months; list ordering; tags with counts.

LATER (not in v1): cover images, ISBN lookup, quotes and highlights, reading time, recommendations.

UI sketch
- Opened when finishing a book, starting a new one, or wondering what to read next. The question is "where am I with my reading this year?"
- At the top: what I'm reading now with how far I've got, and this year's count against the goal (ahead or behind).
- The main action: update the page I'm on, or mark the book finished with a quick 1–5 rating.
- The want-to-read pile, easy to start one from.
- This year's finished books by month, with their ratings.
- "Add a book": title, author, pages, status.
- Day one: an empty state that asks for this year's goal and the first book.
