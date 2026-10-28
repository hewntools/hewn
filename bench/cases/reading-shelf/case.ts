// SPDX-License-Identifier: AGPL-3.0-or-later
// A collection: things with a status, a yearly goal, ratings and tags.
import { idOf, type SeedKit } from "../../lib/cases.ts";

export const name = "Reading Shelf";
export const purpose = "Keep the books I'm reading, have read and want to read, with ratings and a yearly goal, so I know where I am with my reading this year.";
/** How the owner might put it to the intake. */
export const ask = "A reading log: what I'm reading now, what I've finished and what I want to read, with ratings, and how I'm doing against my goal for the year.";
/** What the owner says next, with details and taste. */
export const talk = ["My goal is 18 books this year. I usually have two books going at once and want to update the page I'm on quickly. When I finish one I rate it 1 to 5. I keep a pile of books I want to read and pick the next one from it. I'd like to see my year at a glance, like books on a shelf, and whether I'm ahead or behind. Cosy, like a library."];

// title, author, pages, tags, rating, finished (days ago), days it took
const FINISHED: [string, string, number, string[], number, number, number][] = [
  ["The Left Hand of Darkness", "Ursula K. Le Guin", 304, ["sci-fi", "classic"], 5, 8, 12],
  ["Educated", "Tara Westover", 352, ["memoir"], 4, 26, 15],
  ["Piranesi", "Susanna Clarke", 272, ["fantasy"], 5, 41, 6],
  ["The Body Keeps the Score", "Bessel van der Kolk", 464, ["psychology", "non-fiction"], 3, 70, 30],
  ["Klara and the Sun", "Kazuo Ishiguro", 320, ["literary", "sci-fi"], 4, 95, 9],
  ["Project Hail Mary", "Andy Weir", 496, ["sci-fi"], 5, 120, 10],
  ["Four Thousand Weeks", "Oliver Burkeman", 288, ["non-fiction"], 4, 150, 14],
  ["The Remains of the Day", "Kazuo Ishiguro", 258, ["literary", "classic"], 4, 190, 11],
  ["Sapiens", "Yuval Noah Harari", 512, ["history", "non-fiction"], 3, 230, 40],
];
const READING: [string, string, number, string[], number, number][] = [
  ["The Overstory", "Richard Powers", 512, ["literary"], 214, 9],
  ["Thinking, Fast and Slow", "Daniel Kahneman", 499, ["psychology", "non-fiction"], 120, 30],
];
const WANT: [string, string, number, string[]][] = [
  ["Middlemarch", "George Eliot", 880, ["classic"]],
  ["The Dispossessed", "Ursula K. Le Guin", 387, ["sci-fi", "classic"]],
  ["Braiding Sweetgrass", "Robin Wall Kimmerer", 408, ["non-fiction", "nature"]],
  ["Tomorrow, and Tomorrow, and Tomorrow", "Gabrielle Zevin", 416, ["literary"]],
  ["The Name of the Wind", "Patrick Rothfuss", 662, ["fantasy"]],
];

export async function seed({ call, day }: SeedKit) {
  const year = Number(day(0).slice(0, 4));
  await call("set_goal", { year, target: 18 });
  for (const [title, author, pages, tags, rating, ago, took] of FINISHED) {
    // Only books finished this year count towards it; older ones still show in the list.
    const b = await call("add_book", { title, author, pages, tags, status: "reading", started_on: day(-ago - took) });
    await call("update_book", { id: idOf(b, "book"), status: "finished", finished_on: day(-ago), rating });
  }
  for (const [title, author, pages, tags, page, ago] of READING) {
    const b = await call("add_book", { title, author, pages, tags, status: "reading", started_on: day(-ago) });
    await call("update_progress", { id: idOf(b, "book"), page });
  }
  const dropped = await call("add_book", { title: "Infinite Jest", author: "David Foster Wallace", pages: 1079, tags: ["literary"], status: "reading", started_on: day(-60) });
  await call("update_book", { id: idOf(dropped, "book"), status: "abandoned", note: "Maybe in a long winter" });
  for (const [title, author, pages, tags] of WANT) await call("add_book", { title, author, pages, tags });
}
