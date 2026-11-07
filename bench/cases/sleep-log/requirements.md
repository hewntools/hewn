Runtime: node. No network, no model, no secrets, no connections.

STATE (SQLite)
- nights: id, date (local YYYY-MM-DD, the morning you woke up; unique), bedtime (HH:MM, local), wake_time (HH:MM, local), quality (optional integer 1–5), awakenings (optional integer ≥0), note (optional short text), created_at.
- settings: target_hours (number, default 8), target_bedtime (HH:MM, default "23:00").

DERIVED (pure functions, unit-tested)
- duration_minutes: from bedtime to wake_time, across midnight (23:40 → 06:55 = 435 minutes; a bedtime after midnight such as 00:50 belongs to the same night).
- sleep debt over a window: the sum over the nights logged of (target − duration), never below zero for a single night.
- bedtime consistency: the standard deviation of bedtime in minutes over the window, treating 23:50 and 00:10 as 20 minutes apart.

OPERATIONS (all @1)
- log_night (write): {date?, bedtime, wake_time, quality?, awakenings?, note?} → night with duration_minutes. date defaults to today; logging a date that exists replaces it.
- delete_night (destructive): {date} → {deleted: true}.
- list_nights (read): {from?, to?} → nights newest first, each with duration_minutes.
- summary (read): {days? (default 7), today?} → for the last N days: {avg_duration_minutes, avg_quality, sleep_debt_minutes, bedtime_consistency_minutes, avg_bedtime, avg_wake_time, best_night, worst_night, nights_logged, by_weekday: [{weekday, avg_duration_minutes}]}, plus the same numbers for the N days before ("previous") for comparison. Every read that depends on today takes an optional `today` for tests.
- get_settings (read): {} → settings.
- set_settings (write): {target_hours?, target_bedtime?} → settings.

TESTS
- Duration across midnight and with a bedtime after midnight; replacing a night; debt never negative per night; consistency with bedtimes either side of midnight; summary with gaps, with no data, and the previous-window comparison; settings defaults.

LATER (not in v1): import from a watch, a bedtime reminder, correlating with caffeine or exercise, naps, export.

UI sketch
- Opened in the morning to log last night, and on Sundays to look back. The question is "how am I sleeping lately?"
- At the top: the last 7 nights at a glance: average sleep against the target, the sleep debt, and how regular the bedtime has been, each with the change from the week before.
- The main action: "Log last night" with bedtime and wake time prefilled from the usual times, quality as a 1–5 tap, awakenings and a note optional. One tap to save when the defaults are right.
- A chart of the last 30 nights: hours slept per night against the target, and when I went to bed.
- The nights below, newest first, each editable or deletable.
- Day one: an empty state inviting the first log, with the target shown and editable.
