Runtime: node. No network, no model, no secrets, no connections.

STATE (SQLite)
- habits: id, name (required, e.g. "Stretch"), kind (daily | weekly; default daily), target_per_week (integer 1–7, for weekly habits), archived (boolean), position (integer, for ordering), created_at.
- checkins: id, habit_id, date (local YYYY-MM-DD), created_at; at most one per habit and date. Deleting a habit deletes its check-ins.

STREAKS (pure functions, unit-tested with an injected today)
- daily: consecutive days done, ending today, or ending yesterday when today isn't done yet (today still counts as open).
- weekly: consecutive weeks (Monday–Sunday) that reached target_per_week; the current week counts once reached and doesn't break the streak while it's still open.
- best_streak: the longest run ever, in the habit's own unit (days or weeks).

OPERATIONS (all @1)
- add_habit (write): {name, kind?, target_per_week?} → habit (added last).
- update_habit (write): {id, name?, target_per_week?, archived?, position?} → habit.
- delete_habit (destructive): {id} → {deleted: true}.
- check_in (write): {habit_id, date? (default today)} → {habit_id, date, current_streak}. Doing it twice is fine (no duplicate).
- undo_check_in (write): {habit_id, date? (default today)} → {removed: true|false}.
- today (read): {today?} → the habits that aren't archived, by position, each with done_today, current_streak, best_streak, and for weekly ones done_this_week and target_per_week.
- history (read): {habit_id?, days? (default 30), today?} → per habit: the dates done in the window and the completion rate (done ÷ expected).

TESTS
- Daily streaks with today open and done, broken by a missed day; weekly streaks across week boundaries; best_streak; idempotent check_in and undo; archived habits left out of today; history window edges and completion rate for both kinds.

LATER (not in v1): reminders, a note per check-in, habit groups, statistics beyond 30 days.

UI sketch
- Opened once or twice a day, often on the phone, to tick off what's done. The question is "what's left today?"
- At the top: today's habits, each checked with one tap (tap again to undo), with its streak.
- Below: the last 30 days for each habit, so streaks and gaps are visible at a glance.
- A small "Add habit" form: the name, and daily or N times a week.
- Day one: an empty state suggesting a few habits to start with, each added with one tap.
