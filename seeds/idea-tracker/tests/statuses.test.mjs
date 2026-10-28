// SPDX-License-Identifier: Apache-2.0
// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUSES, OPEN, CLOSED, PILL, isOpen, statusRank, groupIdeas } from "../ui/statuses.js";

test("lifecycle order", () => {
  assert.deepEqual(STATUSES, ["raw", "exploring", "validating", "active", "parked", "shipped", "killed"]);
  assert.ok(statusRank("validating") < statusRank("active"));
  assert.ok(statusRank("active") < statusRank("parked"));
  assert.ok(statusRank("parked") < statusRank("shipped"));
});

test("parked counts as open; only shipped and killed are closed", () => {
  assert.deepEqual(OPEN, ["raw", "exploring", "validating", "active", "parked"]);
  assert.deepEqual(CLOSED, ["shipped", "killed"]);
  assert.equal(isOpen("parked"), true);
  assert.equal(isOpen("active"), true);
  assert.equal(isOpen("shipped"), false);
  assert.equal(isOpen("killed"), false);
});

test("every status has a badge; active has its own colour", () => {
  for (const s of STATUSES) assert.ok(s in PILL);
  const colour = (cls) => cls.split(" ").filter((c) => c !== "with-dot").join(" ");
  for (const s of STATUSES) if (s !== "active") assert.notEqual(colour(PILL[s]), colour(PILL.active));
});

test("open view puts parked in its own section after live statuses", () => {
  const ideas = [
    { id: "p", status: "parked" },
    { id: "a", status: "active" },
    { id: "r", status: "raw" },
  ];
  assert.deepEqual(groupIdeas(ideas, "open"), [
    { label: null, ideas: [{ id: "a", status: "active" }, { id: "r", status: "raw" }] },
    { label: "Parked", ideas: [{ id: "p", status: "parked" }] },
  ]);
});

test("closed view shows only shipped and killed", () => {
  const ideas = [
    { id: "k", status: "killed" },
    { id: "s", status: "shipped" },
    { id: "p", status: "parked" },
  ];
  assert.deepEqual(groupIdeas(ideas, "closed"), [
    { label: "Shipped", ideas: [{ id: "s", status: "shipped" }] },
    { label: "Killed", ideas: [{ id: "k", status: "killed" }] },
  ]);
});

test("empty sections are dropped", () => {
  assert.deepEqual(groupIdeas([{ id: "r", status: "raw" }], "open"), [{ label: null, ideas: [{ id: "r", status: "raw" }] }]);
  assert.deepEqual(groupIdeas([], "open"), []);
});
