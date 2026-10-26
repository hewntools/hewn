// SPDX-License-Identifier: AGPL-3.0-or-later
// A daily check-in: one tap per habit, streaks, a 30-day view. Mostly used on the phone.
import { idOf, type SeedKit } from "../../lib/cases.ts";

export const name = "Habit Check-ins";
export const purpose = "A few daily habits checked off with one tap, with streaks and the last 30 days, so I keep them going.";

// name, kind, target per week, how likely a day is done, done today
const HABITS: [string, "daily" | "weekly", number | null, number, boolean][] = [
  ["Stretch", "daily", null, 0.8, true],
  ["Read to the kids", "daily", null, 0.92, false],
  ["No phone after 22", "daily", null, 0.55, false],
  ["Run", "weekly", 3, 0.45, true],
  ["Call a friend", "weekly", 1, 0.18, false],
];

export async function seed({ call, day, rand }: SeedKit) {
  for (const [name, kind, target, odds, today] of HABITS) {
    const h = await call("add_habit", { name, kind, ...(target ? { target_per_week: target } : {}) });
    const id = idOf(h, "habit");
    for (let ago = 40; ago >= 1; ago--) {
      // A bad patch two weeks ago, and a clean run over the last week for the daily ones.
      const slump = ago >= 13 && ago <= 16 ? 0.4 : 1;
      const run = kind === "daily" && ago <= 6 && name !== "No phone after 22";
      if (run || rand() < odds * slump) await call("check_in", { habit_id: id, date: day(-ago) });
    }
    if (today) await call("check_in", { habit_id: id, date: day(0) });
  }
  const old = await call("add_habit", { name: "Cold shower", kind: "daily" });
  await call("update_habit", { id: idOf(old, "habit"), archived: true });
}
