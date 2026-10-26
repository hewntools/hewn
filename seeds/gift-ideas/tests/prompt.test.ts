// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { operations } from "../src/index.ts";

test("suggest_gifts sends dated notes newest first and weights the last twelve months", async () => {
  let request: any;
  const person = { id: 1, name: "Maya", relation: null, birthday: "02-28", notes: "Likes astronomy", created_at: "2026-01-01" };
  const ctx: any = {
    db: {
      prepare(sql: string) {
        return {
          get: () => person,
          all: () => sql.includes("notes_log")
            ? [{ id: 2, date: "2026-09-01", text: "Wants a star atlas" }, { id: 1, date: "2020-01-01", text: "Wanted a telescope" }]
            : [],
        };
      },
    },
    model: { async generate(req: any) { request = req; return { text: "", json: { suggestions: [{ idea: "Star atlas", why: "Recent wish" }] } }; } },
  };
  const result = await operations["suggest_gifts@1"]({ person_id: 1, today: "2026-10-24" }, ctx);
  assert.equal(result.suggestions[0].idea, "Star atlas");
  assert.ok(request.prompt.includes("Likes astronomy"));
  assert.ok(request.prompt.includes("2026-09-01 [recent — stronger signal]: Wants a star atlas"));
  assert.ok(request.prompt.includes("2020-01-01 [older or future — weaker signal]: Wanted a telescope"));
  assert.ok(request.prompt.indexOf("2026-09-01") < request.prompt.indexOf("2020-01-01"));
  assert.ok(request.schema);
});
