// SPDX-License-Identifier: Apache-2.0
// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStateMessage, hiddenClosedFooter } from "../ui/empty-state.js";

test("no ideas at all", () => {
  assert.deepEqual(emptyStateMessage({ totalIdeas: 0, visibleCount: 0, hiddenClosedCount: 0 }), {
    title: "No ideas yet", hint: "Add one above.", showClosedAction: false,
  });
});

test("closed ideas hidden: singular", () => {
  const m = emptyStateMessage({ totalIdeas: 1, visibleCount: 0, hiddenClosedCount: 1 });
  assert.equal(m.title, "1 closed idea hidden");
  assert.equal(m.showClosedAction, true);
});

test("closed ideas hidden: plural", () => {
  const m = emptyStateMessage({ totalIdeas: 5, visibleCount: 0, hiddenClosedCount: 3 });
  assert.equal(m.title, "3 closed ideas hidden");
  assert.equal(m.showClosedAction, true);
});

test("filters exclude everything, nothing hidden", () => {
  assert.deepEqual(emptyStateMessage({ totalIdeas: 4, visibleCount: 0, hiddenClosedCount: 0 }), {
    title: "No ideas match", hint: "Try other filters.", showClosedAction: false,
  });
});

test("closed view with no closed ideas", () => {
  assert.deepEqual(emptyStateMessage({ totalIdeas: 3, visibleCount: 0, hiddenClosedCount: 0, view: "closed" }), {
    title: "No closed ideas", hint: "Shipped and killed ideas show here.", showClosedAction: false,
  });
});

test("non-empty list has no empty state", () => {
  assert.equal(emptyStateMessage({ totalIdeas: 4, visibleCount: 2, hiddenClosedCount: 2 }), null);
});

test("footer", () => {
  assert.equal(hiddenClosedFooter(0), null);
  assert.equal(hiddenClosedFooter(1), "+ 1 closed hidden");
  assert.equal(hiddenClosedFooter(4), "+ 4 closed hidden");
});
