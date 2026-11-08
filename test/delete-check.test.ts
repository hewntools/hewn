// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's own check that an operation deleting rows is declared destructive, whatever the tool's tests expect: rows
// counted per table before and after each call, in the test cases and the sample replay.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { insertTargets } from "@hewntools/core/abi.ts";
import { editJson, SEED, setup } from "./helpers.ts";
import { startTestHost } from "./workerd-helpers.ts";

/** Running Log with one more operation, `name`, whose code is `body` (a statement list on `db`). */
function withOperation(dir: string, name: string, sideEffect: string, body: string, cases: unknown[], sample?: unknown[]) {
  cpSync(SEED, dir, { recursive: true });
  editJson(join(dir, "capability.json"), (m) => {
    m.operations.push({ name, description: "Test", version: 1, sideEffect, inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object" } });
  });
  appendFileSync(join(dir, "src/index.ts"), `\n(operations as Record<string, unknown>)["${name}@1"] = (input: unknown, { db }: { db: DatabaseSync }) => { ${body}; return {}; };\n`);
  editJson(join(dir, "tests/cases.json"), (c) => c.push(...cases));
  if (sample) writeFileSync(join(dir, "sample/calls.json"), JSON.stringify(sample));
}

const record = { name: "a run to delete", operation: "record_run", input: { distanceKm: 3, durationSeconds: 900, date: "2026-10-05" } };

const swap = `const all = db.prepare("SELECT * FROM runs").all() as Record<string, unknown>[]; db.prepare("DELETE FROM runs").run(); const keep = (input as { keep: number }).keep; for (const r of all.slice(0, keep)) db.prepare("INSERT INTO runs (id, date, distance_km, duration_seconds, notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?)").run("new-" + r.id, r.date, r.distance_km, r.duration_seconds, r.notes, r.recorded_at)`;
const twice = [record, { ...record, name: "another", input: { distanceKm: 4, durationSeconds: 1200, date: "2026-10-06" } }];

describe("an operation that deletes must be declared destructive", () => {
  let t: ReturnType<typeof setup>;
  let dir: string;
  beforeEach(() => {
    t = setup();
    dir = mkdtempSync(join(tmpdir(), "hewn-delete-"));
  });
  afterEach(() => {
    t.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });
  const install = async () => t.platform.settle((await t.platform.install(USER, { name: "Running Log", purpose: "x", builder: `copy:${dir}` })).buildId);

  test("a write whose test leaves a table with fewer rows fails, naming the operation and the table", async () => {
    withOperation(dir, "clear_runs", "write", `db.prepare("DELETE FROM runs").run()`, [record, { name: "clear", operation: "clear_runs", input: {} }]);
    const b = await install();
    assert.equal(b.status, "failed");
    assert.match(b.log.join("\n"), /test 'clear': clear_runs leaves runs with fewer rows and adds none: declare it destructive/);
  });

  test("the same operation declared destructive passes", async () => {
    withOperation(dir, "clear_runs", "destructive", `db.prepare("DELETE FROM runs").run()`, [record, { name: "clear", operation: "clear_runs", input: {} }]);
    const b = await install();
    assert.equal(b.status, "promoted", b.log.join("\n"));
  });

  test("a read that deletes fails too", async () => {
    withOperation(dir, "peek", "read", `db.prepare("DELETE FROM runs").run()`, [record, { name: "peek", operation: "peek", input: {} }]);
    const b = await install();
    assert.equal(b.status, "failed");
    assert.match(b.log.join("\n"), /peek leaves runs with fewer rows and adds none: declare it destructive/);
  });

  test("delete-then-insert that keeps the count is a normal write", async () => {
    withOperation(
      dir,
      "redo_run",
      "write",
      `const r = db.prepare("SELECT * FROM runs LIMIT 1").get() as Record<string, unknown>; db.prepare("DELETE FROM runs WHERE id = ?").run(r.id); db.prepare("INSERT INTO runs (id, date, distance_km, duration_seconds, notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?)").run("new-" + r.id, r.date, r.distance_km, r.duration_seconds, r.notes, r.recorded_at)`,
      [record, { name: "redo", operation: "redo_run", input: {} }],
    );
    const b = await install();
    assert.equal(b.status, "promoted", b.log.join("\n"));
  });


  test("a smaller set swapped in (fewer rows, but new ones added) is a replace", async () => {
    withOperation(dir, "keep_runs", "write", swap, [...twice, { name: "keep one", operation: "keep_runs", input: { keep: 1 } }]);
    const b = await install();
    assert.equal(b.status, "promoted", b.log.join("\n"));
  });

  test("an emptied set adds nothing: a delete", async () => {
    withOperation(dir, "keep_runs", "write", swap, [...twice, { name: "keep none", operation: "keep_runs", input: { keep: 0 } }]);
    const b = await install();
    assert.equal(b.status, "failed");
    assert.match(b.log.join("\n"), /keep_runs leaves runs with fewer rows and adds none: declare it destructive/);
  });

  test("a delete in the sample replay fails the same way", async () => {
    withOperation(dir, "clear_runs", "write", `db.prepare("DELETE FROM runs").run()`, [], [{ operation: "record_run", version: 1, input: { distanceKm: 2, durationSeconds: 600 } }, { operation: "clear_runs", version: 1, input: {} }]);
    const b = await install();
    assert.equal(b.status, "failed");
    assert.match(b.log.join("\n"), /call 2 \(clear_runs\): clear_runs leaves runs with fewer rows and adds none: declare it destructive/);
  });
});

test("the tables a statement inserts into: bare, quoted, after a schema, in WITH, OR REPLACE; never in a literal", () => {
  assert.deepEqual(
    ["INSERT INTO idea_tags (a) VALUES (?)", 'insert or replace into "Night Log" values (1)', "REPLACE INTO main.nights VALUES (1)", "WITH x AS (SELECT 1) INSERT INTO [t] SELECT * FROM x", "SELECT 'insert into fake' FROM t", "INSERT INTO `b` VALUES (1); INSERT INTO c VALUES (2)"].map(insertTargets),
    [["idea_tags"], ["night log"], ["nights"], ["t"], [], ["b", "c"]],
  );
});

test("on the workerd host too: a delete fails, a replace passes", async () => {
  const h = await startTestHost();
  const dir = mkdtempSync(join(tmpdir(), "hewn-delete-"));
  try {
    withOperation(dir, "keep_runs", "write", swap, [...twice, { name: "keep none", operation: "keep_runs", input: { keep: 0 } }]);
    const failed = await h.sv.admin("install", { name: "Running Log", purpose: "x", dir, wait: true });
    assert.equal(failed.status, "failed");
    assert.match(failed.log.join("\n"), /keep_runs leaves runs with fewer rows and adds none: declare it destructive/);
    editJson(join(dir, "tests/cases.json"), (c) => (c.at(-1).input.keep = 1));
    const ok = await h.sv.admin("install", { name: "Running Log", purpose: "x", dir, wait: true });
    assert.equal(ok.status, "promoted", ok.log.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await h.stop();
  }
});
