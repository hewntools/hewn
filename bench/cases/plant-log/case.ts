// SPDX-License-Identifier: AGPL-3.0-or-later
// A tracker with due dates: what needs doing today, grouped by place, with history.
import { idOf, type SeedKit } from "../../lib/cases.ts";

export const name = "Plant Log";
export const purpose = "Keep track of the houseplants in the apartment windows: when each one was last watered, fed and repotted, and which ones need water today, so nothing dries out or gets drowned.";

// name, species, location, water every, feed every, first watering (days ago), last watering (days ago)
const PLANTS: [string, string, string, number, number | null, number, number][] = [
  ["Monstera", "Monstera deliciosa", "Living room window", 7, 14, 30, 9],
  ["Boston fern", "Nephrolepis", "Bathroom", 3, null, 15, 3],
  ["Snake plant", "Sansevieria", "Bedroom north", 14, null, 33, 5],
  ["Pothos", "Epipremnum aureum", "Kitchen window", 7, 30, 27, 6],
  ["Fiddle leaf fig", "Ficus lyrata", "Living room window", 10, 21, 35, 13],
  ["Basil", "", "Kitchen window", 2, null, 7, 1],
  ["Calathea", "Calathea orbifolia", "Bedroom north", 5, null, 24, 4],
  ["Aloe vera", "", "Kitchen window", 21, null, 45, 24],
];

export async function seed({ call, day }: SeedKit) {
  for (const [name, species, location, water, feed, first, last] of PLANTS) {
    const plant = await call("add_plant", { name, location, water_every_days: water, ...(species ? { species } : {}), ...(feed ? { feed_every_days: feed } : {}), last_watered: day(-first) });
    const id = idOf(plant, "plant");
    for (let ago = first - water; ago > last; ago -= water) await call("log_event", { plant_id: id, type: "watered", date: day(-ago) });
    if (last < first) await call("log_event", { plant_id: id, type: "watered", date: day(-last) });
    if (feed) await call("log_event", { plant_id: id, type: "fed", date: day(-last - 3) });
    if (name === "Monstera") {
      await call("log_event", { plant_id: id, type: "repotted", date: day(-71) });
      await call("log_event", { plant_id: id, type: "note", date: day(-5), text: "New leaf unfurling, the third this autumn" });
    }
    if (name === "Calathea") await call("log_event", { plant_id: id, type: "note", date: day(-13), text: "Brown leaf edges: move away from the radiator?" });
  }
}
