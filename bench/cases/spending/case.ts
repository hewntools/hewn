// SPDX-License-Identifier: AGPL-3.0-or-later
// A numbers dashboard: budgets per category, projections, a month against the one before.
import { idOf, type SeedKit } from "../../lib/cases.ts";

export const name = "Spending";
export const purpose = "Note what I spend in a few taps and see, during the month, how each category is doing against its budget.";
/** How the owner might put it to the intake. */
export const ask = "Track what I spend per category against monthly budgets, so I can see mid-month whether I'm on track.";
/** What the owner says next, with details and taste. */
export const talk = ["Categories like groceries, eating out, transport, home, kids and fun, each with a monthly budget in euros; health has no budget. I add expenses on my phone right after paying, so it has to be a couple of taps. Mid-month I want to see which categories are heading over and how this month compares with last. Clear and honest about money, no cutesy piggy banks."];

// name, budget, [low, high] amount, purchases per week, notes
const CATEGORIES: [string, number | null, [number, number], number, string[]][] = [
  ["Groceries", 650, [12, 95], 3.5, ["Weekly shop", "Bakery", "Market"]],
  ["Eating out", 180, [9, 68], 1.4, ["Lunch with Sara", "Pizza night", "Coffee and bun"]],
  ["Transport", 120, [3, 45], 2, ["Bus card top-up", "Fuel", "Train"]],
  ["Home", 220, [8, 140], 0.7, ["Light bulbs", "Curtains", "Cleaning stuff"]],
  ["Kids", 200, [6, 80], 1.1, ["Shoes", "Swimming class", "Birthday present"]],
  ["Fun", 120, [10, 60], 0.6, ["Cinema", "Concert tickets", "Board game"]],
  ["Health", null, [15, 70], 0.3, ["Pharmacy", "Dentist"]],
];

export async function seed({ call, day, rand }: SeedKit) {
  const today = day(0);
  const dom = Number(today.slice(8, 10));
  // Last month in full, and this month so far: about 30 + dom days.
  const span = dom + new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0).getDate() - 1;
  for (const [name, budget, [lo, hi], perWeek, notes] of CATEGORIES) {
    const c = await call("add_category", { name, ...(budget ? { monthly_budget: budget } : {}) });
    const id = idOf(c, "category");
    for (let ago = span; ago >= 0; ago--) {
      // Eating out runs hot this month, so one category is heading over budget.
      const odds = (perWeek / 7) * (name === "Eating out" && ago < dom ? 1.9 : 1);
      if (rand() >= odds) continue;
      const amount = Math.round((lo + rand() * (hi - lo)) * 100) / 100;
      const note = rand() < 0.4 ? notes[Math.floor(rand() * notes.length)] : undefined;
      await call("add_expense", { amount, category_id: id, date: day(-ago), ...(note ? { note } : {}) });
    }
  }
}
