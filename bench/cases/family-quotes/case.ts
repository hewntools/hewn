// SPDX-License-Identifier: AGPL-3.0-or-later
// A memory keeper: short texts with who, when and how old, brought back on their day.
import { idOf, type SeedKit } from "../../lib/cases.ts";

export const name = "Family Quotes";
export const purpose = "Catch the funny and wise things the kids say before they're forgotten, with how old they were, and bring one back now and then.";
/** How the owner might put it to the intake. */
export const ask = "I want to save the funny things my kids say, with how old they were when they said it, and see an old one now and then.";

// who, what, days ago, context, favourite
const QUOTES: [number, string, number, string, boolean][] = [
  [0, "If I eat the crust, will I get curly hair? Then I'll eat it tomorrow.", 2, "Breakfast", false],
  [1, "The moon is following our car because it likes us.", 9, "Driving home in the dark", true],
  [0, "I'm not crying, my eyes are just leaking because of the onions in my heart.", 16, "", false],
  [1, "Dad, when you were small, were there colours?", 30, "Looking at old photos", true],
  [0, "Grandma is old but she's not broken.", 51, "After visiting grandma", false],
  [1, "I want to be a vet for dinosaurs.", 75, "", false],
  [0, "When I'm big I will have a dog and a cat and a sister. Not a brother.", 120, "", false],
  [1, "Snow is just the clouds being lazy and lying down.", 190, "First snow", true],
  [0, "I didn't hit him, my hand just went really fast near his arm.", 260, "Sibling dispute", false],
  [1, "Bumblebees are just bees in a hurry.", 365, "In the garden", false],
  [0, "Why do we say good night when it's dark? It should be good dark.", 365, "Bedtime", true],
  [1, "My tummy is full but my dessert tummy is empty.", 430, "", false],
  [0, "Is tomorrow today yet?", 600, "Christmas Eve morning", false],
  [1, "Mama, your face is old but your laugh is new.", 730, "", true],
];

export async function seed({ call, day }: SeedKit) {
  const year = Number(day(0).slice(0, 4));
  const elsa = idOf(await call("add_person", { name: "Elsa", birthday: `${year - 7}-03-14` }), "person");
  const otto = idOf(await call("add_person", { name: "Otto", birthday: `${year - 4}-08-02` }), "person");
  const people = [elsa, otto];
  for (const [who, text, ago, context, favourite] of QUOTES) {
    // 365: this very day last year, so there's something "on this day".
    const said_on = ago === 365 ? `${year - 1}${day(0).slice(4)}` : day(-ago);
    const q = await call("add_quote", { person_id: people[who], text, said_on, ...(context ? { context } : {}) });
    if (favourite) await call("toggle_favourite", { id: idOf(q, "quote") });
  }
}
