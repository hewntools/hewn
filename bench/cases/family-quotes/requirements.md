Runtime: node. No network, no model, no secrets, no connections.

STATE (SQLite)
- people: id, name (required), birthday (optional YYYY-MM-DD), created_at.
- quotes: id, person_id, text (required), said_on (local YYYY-MM-DD, default today), context (optional short text: where, or what happened), favourite (boolean), created_at. Deleting a person deletes their quotes.

DERIVED (pure functions, unit-tested)
- age_at_time: the person's age on said_on, as {years, months} and as text ("4 years 3 months", "11 months"); none without a birthday.
- on_this_day: quotes said on today's month and day in earlier years, each with how many years ago.

OPERATIONS (all @1)
- add_person (write): {name, birthday?} → person.
- update_person (write): {id, name?, birthday?} → person.
- delete_person (destructive): {id} → {deleted: true}.
- add_quote (write): {person_id, text, said_on?, context?} → quote with person_name and age_at_time.
- update_quote (write): {id, text?, said_on?, context?, person_id?} → quote.
- delete_quote (destructive): {id} → {deleted: true}.
- toggle_favourite (write): {id} → quote.
- list_quotes (read): {person_id?, favourites_only?, query? (matches text and context)} → quotes newest first, each with person_name and age_at_time; and the people, each with their number of quotes and age today.
- bring_back (read): {today?} → {kind: "on_this_day", quotes, years_ago} when there are quotes from this day in earlier years; else {kind: "favourite", quote} picked by the date (the same one all day); else {kind: "none"}.

TESTS
- age_at_time before and after the birthday in the year, for a Feb 29 birthday, under one year, and without a birthday; on_this_day across several years; bring_back's fallbacks and that it's stable within a day; search in text and context; deleting a person removes their quotes.

LATER (not in v1): audio clips, photos, a printed book of the year, sharing with grandparents.

UI sketch
- Opened right after a kid says something funny, often on the phone, and now and then to smile at old ones. The question is "what did they say?"
- The main action first: a quick "Add a quote": who (one tap on a person), the words, context if you like; saved in seconds.
- At the top: one quote brought back "on this day" (or a favourite), with who said it and how old they were.
- Below: all quotes newest first, filterable by person, with search; favourites marked, one tap to mark one.
- Day one: an empty state that asks for the kids' names and birthdays, then the first quote.
