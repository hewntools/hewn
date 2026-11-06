// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

type Ctx = { db: DatabaseSync };
type HabitRow = { id: string; name: string };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => iso(new Date());
/** The calendar day before `date` (YYYY-MM-DD), counted at noon so DST changes don't matter. */
const dayBefore = (date: string) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return iso(d);
};

/** `date` moved by `n` calendar days. */
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return iso(d);
};
/** A real calendar date in YYYY-MM-DD (not 2026-02-31). */
const isRealDate = (date: string) => {
  const d = new Date(`${date}T12:00:00`);
  return !Number.isNaN(d.getTime()) && iso(d) === date;
};

/** Longest run of consecutive days in an ascending list of dates. */
function longestRun(dates: string[]): number {
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of dates) {
    run = prev !== null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

function habit(db: DatabaseSync, habitId: string): HabitRow {
  const row = db.prepare("SELECT id, name FROM habits WHERE id = ?").get(habitId) as HabitRow | undefined;
  if (!row) throw new Error(`no habit with id ${habitId}`);
  return row;
}

const done = (db: DatabaseSync, habitId: string, date: string) => !!db.prepare("SELECT 1 FROM check_ins WHERE habit_id = ? AND date = ?").get(habitId, date);

/** Days in a row up to `date`. A day not checked in yet doesn't break the streak until it's over. */
function streak(db: DatabaseSync, habitId: string, date: string): number {
  let day = done(db, habitId, date) ? date : dayBefore(date);
  let n = 0;
  while (done(db, habitId, day)) (n++, (day = dayBefore(day)));
  return n;
}

function day(db: DatabaseSync, date: string) {
  const habits = db.prepare("SELECT id, name FROM habits ORDER BY created_at, rowid").all() as HabitRow[];
  return habits.map((h) => ({ habitId: h.id, name: h.name, done: done(db, h.id, date), streak: streak(db, h.id, date) }));
}

export const operations = {
  "add_habit@1"(input: { name: string }, { db }: Ctx) {
    const habitId = randomUUID();
    db.prepare("INSERT INTO habits (id, name, created_at) VALUES (?, ?, ?)").run(habitId, input.name, new Date().toISOString());
    return { habitId };
  },

  "check_in@1"(input: { habitId: string; date?: string }, { db }: Ctx) {
    const h = habit(db, input.habitId);
    const date = input.date ?? today();
    db.prepare("INSERT OR IGNORE INTO check_ins (habit_id, date) VALUES (?, ?)").run(h.id, date);
    return { habitId: h.id, date, streak: streak(db, h.id, date) };
  },

  "undo_check_in@1"(input: { habitId: string; date?: string }, { db }: Ctx) {
    const r = db.prepare("DELETE FROM check_ins WHERE habit_id = ? AND date = ?").run(input.habitId, input.date ?? today());
    return { undone: Number(r.changes) > 0 };
  },

  "get_day@1"(input: { date?: string }, { db }: Ctx) {
    const date = input.date ?? today();
    return { date, habits: day(db, date) };
  },

  "get_history@1"(input: { to?: string; days?: number }, { db }: Ctx) {
    const to = input.to ?? today();
    if (!isRealDate(to)) throw new Error(`${to} is not a calendar date`);
    const from = addDays(to, -((input.days ?? 35) - 1));
    const habits = db.prepare("SELECT id, name, created_at FROM habits ORDER BY created_at, rowid").all() as (HabitRow & { created_at: string })[];
    const all = db.prepare("SELECT habit_id, date FROM check_ins ORDER BY habit_id, date").all() as { habit_id: string; date: string }[];
    const byHabit = new Map<string, string[]>();
    for (const c of all) {
      const list = byHabit.get(c.habit_id);
      if (list) list.push(c.date);
      else byHabit.set(c.habit_id, [c.date]);
    }
    return {
      from,
      to,
      habits: habits.map((h) => {
        const dates = byHabit.get(h.id) ?? [];
        const added = iso(new Date(h.created_at));
        const since = dates.length && dates[0] < added ? dates[0] : added;
        return {
          habitId: h.id,
          name: h.name,
          since,
          days: dates.filter((d) => d >= from && d <= to),
          streak: streak(db, h.id, to),
          best: longestRun(dates),
        };
      }),
    };
  },

  // Widgets get a read-only database. The button runs check_in@1, a normal (writing) call.
  "widget_today@1"(_input: Record<string, never>, { db }: Ctx) {
    const habits = day(db, today());
    const count = habits.filter((h) => h.done).length;
    const next = habits.find((h) => !h.done);
    const buttons = next ? [{ label: `Done: ${next.name}`.slice(0, 24), operation: "check_in@1", input: { habitId: next.habitId } }] : [];
    const list = {
      template: "list",
      items: habits.slice(0, 5).map((h) => ({ title: `${h.done ? "✓" : "○"} ${h.name}`, value: `${h.streak} d` })),
      empty: "No habits yet",
      buttons,
    };
    return {
      small: { template: "progress", value: count, max: Math.max(1, habits.length), label: "Done today", caption: `${count} of ${habits.length}`, buttons },
      medium: list,
      large: list,
    };
  },
};
