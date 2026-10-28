Runtime: node. No network, no model, no secrets, no connections.

STATE (SQLite)
- plants: id, name (required, e.g. "Monstera"), species (optional free text), location (free text, the window or room, e.g. "Kitchen window", "Bedroom north"), water_every_days (integer ≥1, required, default 7), feed_every_days (optional integer; null = not tracked), notes (optional short text), created_at.
- events: id, plant_id, type (watered | fed | repotted | note), date (local YYYY-MM-DD, owner's timezone), text (optional; required for type note), created_at. Deleting a plant deletes its events.

DUE LOGIC (pure functions, unit-tested with an injected 'today')
- next_water = date of the latest 'watered' event + water_every_days. A plant that has never been watered is due today (from the day it was added).
- status: 'overdue' (next_water < today, with days_overdue), 'today' (= today), or 'ok' (with days_until).
- The same for feeding when feed_every_days is set (next_feed, feed_status). Repotted only shows as 'last repotted' plus how long ago.
- Sort for 'due' views: most overdue first, then due today, then by location, then name.
- Every read operation that computes due status takes an optional `today` (YYYY-MM-DD) for tests and otherwise uses the owner's local date.

OPERATIONS (all @1)
- add_plant (write): {name, location?, species?, water_every_days?, feed_every_days?, notes?, last_watered?} → plant. If last_watered (a date) is given, it records a 'watered' event on that date so the schedule starts correctly.
- update_plant (write): {id, any of the plant fields} → plant.
- delete_plant (destructive): {id} → {deleted: true}. Removes the plant and all its history.
- log_event (write): {plant_id, type, date? (default today), text?} → event. The general log for watering, feeding, repotting or a note, including back-dating.
- water (write): {plant_ids: [id…], date?} → {watered: [{id, name, next_water}]}. Waters several plants at once from the screen.
- water_due (write, no input): records 'watered' today for every plant that is overdue or due today → {count, names}. Used by the widget button.
- water_next (write, no input): waters only the first plant in the due order → {plant|null}. Used by the widget button.
- delete_event (destructive): {id} → {deleted: true}. Fixes a wrong tap.
- list_plants (read): {location?, today?} → plants with location, last_watered, next_water, status, days_overdue/days_until, last_fed/feed_status, last_repotted, sorted in due order. Also returns a list of the distinct locations.
- get_plant (read): {id, today?} → the plant with its computed status and its full event history, newest first.
- widget_due (read, no input; offline, reads only stored data): returns a view model per size.
  - small: stat, the number of plants needing water today (overdue plus today), caption "need water" (or "All watered" when it's 0).
  - medium: list, the first 3 due plants (title = name, detail = location, value = "today" / "2 days late"), with buttons "Watered all" (water_due) and "Watered <first name>" (water_next).
  - large: list, the first 5 due plants, same rows and buttons. When nothing is due, it shows the next plant coming up ("Next: Fern, in 2 days").
  - With no plants at all: a short text such as "Add your first plant".
  - Labels must fit the template limits: truncate long names; the button label falls back to "Watered next" when it's too long.

TESTS
- Due math: never watered, due today, overdue by N days, not yet due, back-dated watering, interval changed after the last watering, month and year boundaries.
- Feed status only when feed_every_days is set.
- water_due waters exactly the due plants and leaves the others alone; water_next waters the most overdue one; both handle an empty list.
- delete_plant also removes its events; delete_event changes the computed status back.
- Validation: water_every_days ≥1, a note needs text, an unknown plant_id gives a clear error.
- widget_due views at every size, with no plants, with nothing due, and with more than 5 due; text stays within the template limits.

LATER (not in v1): photos and growth over time, the model identifying a plant or diagnosing a problem from a photo, summer and winter watering intervals, a 'soil still damp, remind me in N days' snooze, care tips per species, export.

UI sketch
- Opened when it's time to water, or after buying or repotting a plant. The question is "what needs water today?"
- At the top: "Needs water today" with the overdue plants in red-ish and those due today normal, each with a check to tick, plus a "Watered selected" button (water).
- Below: all plants grouped by window/location, each row showing the name, last watered ("4 days ago") and when it's next due. A location filter sits at the top of the list.
- Tapping a plant opens its page: details (editable interval, location, notes), quick buttons for Watered / Fed / Repotted / Add note (the date defaults to today and can be changed), and the history list with delete on each entry.
- An "Add plant" form: name, location (suggesting existing ones), water every [7] days, feed every (optional), last watered (optional, defaults to today).
- Day one with no plants: an empty state explaining you add a plant with its window and how often it needs water, with the Add plant form right there.
