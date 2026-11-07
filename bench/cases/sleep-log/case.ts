// SPDX-License-Identifier: AGPL-3.0-or-later
// A time-series dashboard: a nightly log with averages, a target and trends.
import type { SeedKit } from "../../lib/cases.ts";

export const name = "Sleep Log";
export const purpose = "Log each night's sleep in a few taps and see how much and how regularly I sleep, against my target, week by week.";
/** How the owner might put it to the intake. */
export const ask = "Help me keep an eye on my sleep. I'd log when I went to bed and woke up, and want to see if I'm getting enough and going to bed at regular times.";
/** What the owner says next, with details and taste. */
export const talk = ["I aim for about 7.5 hours and want to be in bed by 23:00. I'd log it in the morning on my phone, half asleep, so it has to be quick: usually the same times as the night before. I'd also like to note how I slept, 1 to 5, and whether the kids woke me. On Sundays I want to see the week: am I short on sleep, and am I drifting later? Make it feel like night, calm, not clinical."];

const hhmm = (minutes: number) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

const NOTES = ["Late series episode", "Kids woke up twice", "Coffee after 4 pm", "Ran in the evening, slept like a log", "Hot room", "Early flight"];

export async function seed({ call, day, rand }: SeedKit) {
  await call("set_settings", { target_hours: 7.5, target_bedtime: "23:00" });
  for (let ago = 34; ago >= 0; ago--) {
    if (ago === 12 || ago === 20 || ago === 27) continue; // forgot to log
    const date = new Date(`${day(-ago)}T12:00:00`);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    // Bedtime drifts later on weekends and in the last week; wake time is earlier on weekdays.
    const bed = 23 * 60 + 5 + (weekend ? 55 : 0) + (ago < 7 ? 25 : 0) + (rand() - 0.5) * 50;
    const wake = (weekend ? 7 * 60 + 50 : 6 * 60 + 40) + (rand() - 0.5) * 40;
    const hours = (wake + 1440 - bed) / 60;
    const quality = Math.max(1, Math.min(5, Math.round(hours - 3.4 + (rand() - 0.5) * 1.6)));
    const awakenings = Math.floor(rand() * (quality <= 2 ? 4 : 2));
    const note = rand() < 0.18 ? NOTES[Math.floor(rand() * NOTES.length)] : undefined;
    await call("log_night", { date: day(-ago), bedtime: hhmm(bed), wake_time: hhmm(wake), quality, awakenings, ...(note ? { note } : {}) });
  }
}
