// SPDX-License-Identifier: AGPL-3.0-or-later
// The example tools in seeds/ install through the full validation (manifest, bundle, contracts,
// migrations, their own test cases, widgets drawn in every size), and do what they say.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { installFrom, setup } from "./helpers.ts";

const SEEDS = resolve(import.meta.dirname, "../seeds");

describe("seeds", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());
  const call = async (capabilityId: string, operation: string, input: Record<string, unknown> = {}) =>
    (await t.platform.invoke(USER, { capabilityId, operation, input })).result as any;

  for (const id of readdirSync(SEEDS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    test(`${id} installs and passes its own tests`, async () => {
      const r = await installFrom(t.platform, join(SEEDS, id));
      assert.equal(r.status, "promoted");
    });
  }

  test("macOS metadata files (._*, .DS_Store) are ignored, not refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-appledouble-"));
    try {
      cpSync(join(SEEDS, "running-log"), dir, { recursive: true });
      for (const f of ["._capability.json", "migrations/._001_init.sql", ".DS_Store", "src/.DS_Store"]) writeFileSync(join(dir, f), "\u0000\u0005\u0016\u0007Mac OS X");
      const r = await installFrom(t.platform, dir);
      assert.equal(r.status, "promoted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reading list: progress, finishing, the nightstand", async () => {
    await installFrom(t.platform, join(SEEDS, "reading-list"));
    const { bookId } = await call("reading-list", "add_book", { title: "Middlemarch", author: "George Eliot", pages: 880 });
    assert.deepEqual(await call("reading-list", "set_progress", { bookId, page: 440 }), { bookId, page: 440, percent: 50 });
    assert.equal((await call("reading-list", "list_books", { status: "reading" })).books.length, 1, "progress moves it to reading");
    const w = await call("reading-list", "widget_nightstand");
    assert.deepEqual(w.small, { template: "progress", value: 440, max: 880, label: "Middlemarch", caption: "50%" });
    await call("reading-list", "finish_book", { bookId, rating: 5, date: "2026-10-19" });
    assert.deepEqual((await call("reading-list", "list_books", { status: "finished" })).books[0], {
      bookId, title: "Middlemarch", author: "George Eliot", status: "finished", pages: 880, page: 880, rating: 5, finishedOn: "2026-10-19",
    });
    await assert.rejects(call("reading-list", "set_progress", { bookId, page: 1 }), /already finished/);
  });

  test("habits: check-ins, streaks across days, undo, the widget's button", async () => {
    await installFrom(t.platform, join(SEEDS, "habits"));
    const { habitId } = await call("habits", "add_habit", { name: "Stretch" });
    for (const date of ["2026-01-10", "2026-01-11", "2026-01-12"]) await call("habits", "check_in", { habitId, date });
    assert.equal((await call("habits", "check_in", { habitId, date: "2026-01-12" })).streak, 3, "twice is once");
    assert.equal((await call("habits", "get_day", { date: "2026-01-13" })).habits[0].streak, 3, "a day not done yet doesn't break it");
    assert.deepEqual(await call("habits", "undo_check_in", { habitId, date: "2026-01-11" }), { undone: true });
    assert.equal((await call("habits", "get_day", { date: "2026-01-12" })).habits[0].streak, 1);
    const w = await call("habits", "widget_today");
    assert.deepEqual(w.small.buttons, [{ label: "Done: Stretch", operation: "check_in@1", input: { habitId } }]);
    await call("habits", w.small.buttons[0].operation.split("@")[0], w.small.buttons[0].input);
    assert.equal((await call("habits", "widget_today")).small.value, 1);
  });
});
