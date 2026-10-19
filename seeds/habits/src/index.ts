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
