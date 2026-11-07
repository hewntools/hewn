// SPDX-License-Identifier: AGPL-3.0-or-later
// A brief (a new tool's or a change's) read back into its parts for the proposal card (web/app/brief.js):
// the headings as the intake writes them and as a model might vary them, list items, and text that isn't
// a brief.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

const { briefParts, changeLine } = (await import(join(import.meta.dirname, "../packages/host-workerd/web/app/brief.js"))) as { briefParts: (text?: string | null) => Record<string, string>; changeLine: (text?: string) => string };

describe("a brief's parts", () => {
  test("each heading on a line of its own, its lines after it", () => {
    const brief = "FOR\nThe owner, after a ride.\n\nKEEPS\nEach ride: the date and how far.\n\nDECIDED\n300 km between oilings.\nLeft for later: more than one bike.\n\nPLATFORM\nNothing external.\n\nUI INTENT\nQuick to log.";
    assert.deepEqual(briefParts(brief), {
      FOR: "The owner, after a ride.",
      KEEPS: "Each ride: the date and how far.",
      DECIDED: "300 km between oilings. · Left for later: more than one bike.",
      PLATFORM: "Nothing external.",
      "UI INTENT": "Quick to log.",
    });
  });

  test("list items lose their markers and are joined with a dot", () => {
    assert.equal(briefParts("KEEPS\n- Kids: a name and a birthday.\n- Quotes: the words and the date.").KEEPS, "Kids: a name and a birthday. · Quotes: the words and the date.");
    assert.equal(briefParts("DECIDED\n* Euros only.\n• Entry is manual.").DECIDED, "Euros only. · Entry is manual.");
    assert.equal(briefParts("DECIDED\n1. Euros only.\n2) Entry is manual.").DECIDED, "Euros only. · Entry is manual.");
  });

  test("headings in any case, as Markdown, with a colon, or with their first line after the colon", () => {
    for (const heading of ["KEEPS", "Keeps", "keeps:", "**KEEPS**", "**Keeps:**", "## Keeps", "### KEEPS:", "* KEEPS"]) assert.deepEqual(briefParts(`${heading}\nRides.`), { KEEPS: "Rides." }, heading);
    assert.deepEqual(briefParts("Keeps: Rides.\nOilings."), { KEEPS: "Rides. · Oilings." });
    assert.deepEqual(briefParts("**Decided:** 300 km."), { DECIDED: "300 km." });
    assert.deepEqual(briefParts("UI intent\nCalm.\n\nUI_INTENT: Green."), { "UI INTENT": "Green." }, "a later heading of the same part replaces it");
    assert.deepEqual(briefParts("FOR: The owner. KEEPS: Rides. DECIDED: 300 km. PLATFORM: Nothing external."), { FOR: "The owner.", KEEPS: "Rides.", DECIDED: "300 km.", PLATFORM: "Nothing external." });
  });

  test("a sentence that starts like a heading stays in its part", () => {
    assert.deepEqual(briefParts("DECIDED\nFOR now, one bike.\nKEEPS track of nothing else.\nPlatform fees aside."), { DECIDED: "FOR now, one bike. · KEEPS track of nothing else. · Platform fees aside." });
    assert.equal(briefParts("KEEPS\nRides, good for: commutes.").KEEPS, "Rides, good for: commutes.", "a lower-case word and a colon mid-line isn't a heading");
  });

  test("a change's brief: what changes and what stays, as the other parts", () => {
    const brief = "CHANGES\n- Each run gets an optional note.\n- The list shows it.\n\nSTAYS\nExisting operation contracts stay backward compatible.\nEvery run logged so far.\n\nDECIDED\nOld runs get no note.\n\nPLATFORM\nNothing new.";
    assert.deepEqual(briefParts(brief), {
      CHANGES: "Each run gets an optional note. · The list shows it.",
      STAYS: "Existing operation contracts stay backward compatible. · Every run logged so far.",
      DECIDED: "Old runs get no note.",
      PLATFORM: "Nothing new.",
    });
    for (const heading of ["CHANGES", "Changes:", "**Changes**", "**CHANGES:**", "## Changes"]) assert.deepEqual(briefParts(`${heading}\nA note per run.`), { CHANGES: "A note per run." }, heading);
    for (const heading of ["STAYS", "stays:", "**Stays:**", "### STAYS"]) assert.deepEqual(briefParts(`${heading}\nThe runs.`), { STAYS: "The runs." }, heading);
    assert.deepEqual(briefParts("CHANGES: A note per run. STAYS: Existing operation contracts stay backward compatible. DECIDED: Optional."), { CHANGES: "A note per run.", STAYS: "Existing operation contracts stay backward compatible.", DECIDED: "Optional." });
    assert.deepEqual(briefParts("DECIDED\nChanges to old runs are out of scope.\nStays the same for agents."), { DECIDED: "Changes to old runs are out of scope. · Stays the same for agents." }, "sentences that start with the words aren't headings");
  });

  test("a request in one line: a change's brief by what it changes, anything else by its first line", () => {
    assert.equal(changeLine("CHANGES\n- Each run gets a note.\n- The list shows it.\n\nSTAYS\nExisting operation contracts stay backward compatible."), "Each run gets a note. · The list shows it.");
    assert.equal(changeLine("**Changes:** A note per run.\n**Decided:** Optional."), "A note per run.");
    assert.equal(changeLine("Add a notes field to each run.\nrecord_run@2: add optional notes."), "Add a notes field to each run.", "a change from before 0.4.10");
    assert.equal(changeLine("Log bike rides and remember when the chain needs oiling."), "Log bike rides and remember when the chain needs oiling.", "a new tool's purpose");
    assert.equal(changeLine(""), "");
  });

  test("missing parts are missing; text before the first heading, and text without headings, is no part", () => {
    assert.deepEqual(briefParts("A plant log.\n\nKEEPS\nPlants."), { KEEPS: "Plants." });
    assert.deepEqual(briefParts("KEEPS\n\nDECIDED\nWeekly."), { KEEPS: "", DECIDED: "Weekly." });
    assert.deepEqual(briefParts("Operations: log_ride (date, km), list_rides.\nState: rides, oilings.\nTests: the interval maths."), {});
    assert.deepEqual(briefParts(""), {});
    assert.deepEqual(briefParts(undefined), {});
  });
});
