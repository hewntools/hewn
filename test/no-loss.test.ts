// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's own no-loss check (0.4.13): around a candidate's migrations, on a copy of the tool's data (or the version it
// replaces filled with its sample), every row keeps its key and none go in all; the reads that take no input still
// return every record they did. A build it stops is "caught".
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { lostRows } from "@hewntools/core/abi.ts";
import { prometheusText } from "@hewntools/cli/supervisor/metrics.ts";
import { editJson, editText, FIXTURES, installFrom, installSeed, setup } from "./helpers.ts";

const migration = (sql: string, name = "002_change.sql") => (ws: string) => writeFileSync(join(ws, "migrations", name), sql);
// The lint refuses DELETE and DROP in a migration; a table rebuilt beside the old one isn't refused, and copies back
// all its rows or only some (`where`).
const rebuild = (where = "") => `ALTER TABLE runs RENAME TO runs_v1;
CREATE TABLE runs (id TEXT PRIMARY KEY, date TEXT NOT NULL, distance_km REAL NOT NULL, duration_seconds INTEGER NOT NULL, notes TEXT, recorded_at TEXT NOT NULL);
INSERT INTO runs SELECT * FROM runs_v1${where};
CREATE INDEX runs_on_date ON runs (date);
`;

test("the no-loss rules: keys kept per table, no fewer rows in all; a rename, a merge or a split passes", () => {
  const k = (...ids: number[]) => ids.map((i) => JSON.stringify([i]));
  assert.deepEqual(lostRows({ runs: k(1, 2, 3) }, { runs: k(1, 2, 3, 4) }), [], "rows added");
  assert.deepEqual(lostRows({ runs: k(1, 2) }, { run_entries: k(1, 2) }), [], "a rename");
  assert.deepEqual(lostRows({ a: k(1), b: k(2) }, { ab: k(1, 2) }), [], "a merge");
  assert.deepEqual(lostRows({ runs: k(1, 2, 3) }, { runs: k(1) }), ["`runs` would lose 2 of its 3 rows", "2 fewer rows across its tables (3 before, 1 after)"]);
  assert.deepEqual(lostRows({ runs: k(1, 2) }, { runs: k(11, 12) }), ["`runs` would lose 2 of its 2 rows (their keys change)"], "renumbered");
  assert.deepEqual(lostRows({ runs: k(1, 2), old: k(3) }, { runs: k(1, 2) }), ["1 fewer rows across its tables (3 before, 2 after)"], "a dropped table's rows gone");
});

describe("Hewn's no-loss check", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());
  const run = (km: number, capabilityId = "running-log") => t.platform.invoke(USER, { capabilityId, operation: "record_run", input: { distanceKm: km, durationSeconds: 1500, date: "2026-10-01" } });
  const change = async (edit: (ws: string) => void, capabilityId = "running-log") => {
    t.queue(edit);
    return t.platform.settle((await t.platform.modify(USER, { capabilityId, request: "change" })).buildId);
  };
  const active = () => t.platform.registry.getCapability("running-log")!.activeVersion;

  test("a migration that would lose the owner's rows is stopped before it goes live, naming the table and how many: caught", async () => {
    for (const km of [3, 4, 8]) await run(km);
    const before = active();
    const b = await change(migration(rebuild(" WHERE NOT (distance_km < 5 AND date = '2026-10-01')")));
    assert.equal(b.status, "failed", b.log.join("\n"));
    assert.match(b.log.join("\n"), /migration 002_change\.sql would lose data on a copy of the tool's data:\n {2}- `runs` would lose 2 of its \d+ rows\n/);
    assert.deepEqual([b.failure?.title, b.failure?.detail, b.failure?.caught], ["Stopped before it went live", "2 rows of runs would have been lost.", true]);
    assert.equal(active(), before, "nothing went live");
    const runs = (await t.platform.invoke(USER, { capabilityId: "running-log", operation: "list_runs", input: { from: "2026-10-01", to: "2026-10-01" } })).result as { runs: unknown[] };
    assert.equal(runs.runs.length, 3, "the owner's data as it was");
    // The build-quality count: how often the copy saved the owner's data.
    const m = t.platform.metrics(USER);
    assert.equal(m.buildsCaught, 1);
    assert.match(prometheusText(m, "0.4.13"), /^hewn_builds_caught 1$/m);
  });

  test("rows that keep their keys pass: the table rebuilt with all its rows, then a new column", async () => {
    await run(5);
    const rebuilt = await change(migration(rebuild()));
    assert.equal(rebuilt.status, "promoted", rebuilt.log.join("\n"));
    assert.ok(rebuilt.log.some((l) => /no data lost by the migrations on a copy of the tool's data \(\d+ rows kept\)/.test(l)), rebuilt.log.join("\n"));
    const added = await change(migration("ALTER TABLE runs ADD COLUMN shoes TEXT;\n", "003_shoes.sql"));
    assert.equal(added.status, "promoted", added.log.join("\n"));
    assert.equal(t.platform.metrics(USER).buildsCaught, 0);
  });

  test("keys that change count as lost", async () => {
    await run(5);
    const b = await change(migration("UPDATE runs SET id = id || '-1';\n"));
    assert.equal(b.status, "failed", b.log.join("\n"));
    assert.match(b.log.join("\n"), /`runs` would lose \d+ of its \d+ rows \(their keys change\)/);
    assert.equal(b.failure?.caught, true);
  });

  test("a tool with no data of its own is checked on the version it replaces, filled with its sample data: an agent's check catches it too", async () => {
    const pack = await t.platform.pack(t.claude, { kind: "modify", capabilityId: "running-log" });
    const files = pack.files.filter((f) => !/^(CONTRACTS\.md|OTHER_TOOLS\.md|PLATFORM_UI\.css|\.hewn-contracts\/)/.test(f.path));
    const checked = await t.platform.checkFiles(t.claude, { files: [...files, { path: "migrations/002_clear.sql", content: rebuild(" WHERE 0") }], capabilityId: "running-log" });
    assert.equal(checked.passed, false, checked.text);
    assert.match(checked.failures.join("\n"), /^migration 002_clear\.sql would lose data on its sample data in the version it replaces:\n {2}- `runs` would lose \d+ of its \d+ rows/m);
  });

  test("a read of the old version that ever stalled isn't called: no restart, nothing blamed, the change goes live", async () => {
    // Runaway's spin@1 is a read that never lets go; on the Node host it would hold the test forever.
    await installFrom(t.platform, join(FIXTURES, "runaway"));
    await t.platform.invoke(USER, { capabilityId: "runaway", operation: "tick", input: { tag: "a" } });
    t.platform.registry.setKv("stalled-ops:runaway", ["spin@1"]);
    const lifecycle = () => t.platform.registry.lifecycleEvents().filter((e) => e.capabilityId === "runaway" && /stall|suspend/.test(e.action)).length;
    const before = lifecycle();
    const b = await change(migration("CREATE TABLE notes (id TEXT PRIMARY KEY);\n"), "runaway");
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.ok(b.log.some((l) => /no-loss check: spin@1 left out \(it stalled before\)/.test(l)), b.log.join("\n"));
    assert.ok(b.log.some((l) => /no data lost by the migrations on a copy of the tool's data/.test(l)), b.log.join("\n"));
    assert.equal(lifecycle(), before, "no stall, no strike");
  });

  test("a read that no longer returns records it did after the migrations fails, though no row is lost", async () => {
    // Running Log whose list_runs also says each run's id.
    const dir = mkdtempSync(join(tmpdir(), "hewn-run-ids-"));
    cpSync(FIXTURES + "/running-log", dir, { recursive: true });
    editJson(join(dir, "capability.json"), (m) => ((m.id = "run-ids"), (m.name = "Run Ids")));
    editText(join(dir, "src", "index.ts"), (s) => s.replace("runId: r.id,", "runId: r.id,\n        id: r.id,"));
    await installFrom(t.platform, dir);
    rmSync(dir, { recursive: true, force: true });
    for (const km of [3, 4, 8]) await run(km, "run-ids");
    // The runs under 5 km are hidden from list_runs by the new version: still there, no longer returned.
    const b = await change((ws) => {
      migration("ALTER TABLE runs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;\nUPDATE runs SET hidden = 1 WHERE distance_km < 5;\n")(ws);
      editText(join(ws, "src", "index.ts"), (s) => s.replace("FROM runs ${w.sql} ORDER BY", "FROM (SELECT * FROM runs WHERE hidden = 0) ${w.sql} ORDER BY"));
    }, "run-ids");
    assert.equal(b.status, "failed", b.log.join("\n"));
    assert.match(b.log.join("\n"), /would lose data on a copy of the tool's data:\n {2}- list_runs@1 would no longer return \d+ of the \d+ records it returned/);
    assert.match(b.failure?.detail ?? "", /^list_runs@1 would no longer have returned \d+ of its records\.$/);
  });
});
