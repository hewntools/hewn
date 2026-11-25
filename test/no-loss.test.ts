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
import { keysSince, lostRows, markKeys } from "@hewntools/core/abi.ts";
import { explainFailure } from "@hewntools/core/failure.ts";
import { migrationProblems } from "@hewntools/core/migrations.ts";
import { DRY_RUN_FAILED, idsIn, NO_LOSS_FAILED, type Validation } from "@hewntools/core/platform/validation.ts";
import { abiDb } from "@hewntools/test-host/runtime.ts";
import { DatabaseSync } from "node:sqlite";
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

/** The no-loss rules on a real database: `setup` before the snapshot, `migrate` after it; what lostRows says. */
function measured(setupSql: string, migrateSql: string) {
  const raw = new DatabaseSync(":memory:");
  const db = abiDb(raw);
  db.exec(setupSql);
  markKeys(db);
  db.exec(migrateSql);
  const since = keysSince(db);
  const left = raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_hewn_keys%'").all();
  raw.close();
  assert.deepEqual(left, [], "the snapshots are dropped");
  return { lost: lostRows(since), since };
}
const runs = (n: number, table = "runs") => `CREATE TABLE ${table} (id TEXT PRIMARY KEY, km REAL);\n${Array.from({ length: n }, (_, i) => `INSERT INTO ${table} VALUES ('r${i + 1}', ${i + 1});`).join("\n")}`;

test("the no-loss rules: keys kept per table, no fewer rows in all; a rename, a merge or a split passes", () => {
  assert.deepEqual(measured(runs(3), "INSERT INTO runs VALUES ('r4', 4);").lost, [], "rows added");
  assert.deepEqual(measured(runs(2), "ALTER TABLE runs RENAME TO run_entries;").lost, [], "a rename");
  assert.deepEqual(measured(`${runs(1, "a")}\nCREATE TABLE b (id TEXT PRIMARY KEY, km REAL); INSERT INTO b VALUES ('r9', 9);`, "CREATE TABLE ab (id TEXT PRIMARY KEY, km REAL); INSERT INTO ab SELECT * FROM a; INSERT INTO ab SELECT * FROM b; DROP TABLE a; DROP TABLE b;").lost, [], "a merge");
  assert.deepEqual(measured(runs(3), "DELETE FROM runs WHERE id != 'r1';").lost, ["`runs` would lose 2 of its 3 rows", "2 fewer rows across its tables (3 before, 1 after)"]);
  assert.deepEqual(measured(runs(2), "UPDATE runs SET id = id || '-x';").lost, ["`runs` would lose 2 of its 2 rows (their keys change)"], "renumbered");
  assert.deepEqual(measured(`${runs(2)}\nCREATE TABLE old (id TEXT PRIMARY KEY); INSERT INTO old VALUES ('o');`, "DROP TABLE old;").lost, ["1 fewer rows across its tables (3 before, 2 after)"], "a dropped table's rows gone");
});

test("the no-loss rules see through a rename, and compare counts where the key itself changes", () => {
  assert.deepEqual(measured(runs(2), "ALTER TABLE runs RENAME TO run_entries; UPDATE run_entries SET id = id || '-x';").lost, ["`runs` would lose 2 of its 2 rows (their keys change)"], "renamed, then renumbered");
  assert.deepEqual(measured("CREATE TABLE n (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO n VALUES (1, 'a'), (2, 'b');", "ALTER TABLE n RENAME TO n_v1; CREATE TABLE n (id TEXT PRIMARY KEY, v TEXT); INSERT INTO n SELECT id, v FROM n_v1;").lost, [], "INTEGER keys as TEXT keep their keys");
  assert.deepEqual(measured("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('a'), ('b');", "ALTER TABLE notes RENAME TO notes_v1; CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) SELECT body FROM notes_v1;").lost, [], "a key added to a table without one: its rows counted");
  const { lost, since } = measured("CREATE VIRTUAL TABLE s_fts USING fts5(body); INSERT INTO s_fts (body) VALUES ('a'), ('b'), ('c');", "INSERT INTO s_fts(s_fts) VALUES('optimize');");
  assert.deepEqual(lost, [], "an FTS index and its shadow tables aren't the tool's rows");
  assert.deepEqual(Object.keys(since.tables), []);
});

test("the no-loss rules after the second review: each key as often as before, NULL its own, renames followed by their pages, a table beside an FTS index", () => {
  assert.deepEqual(measured("CREATE TABLE d (id PRIMARY KEY, v); INSERT INTO d VALUES (1, 'a'), ('1', 'b');", "UPDATE OR REPLACE d SET id = 1 WHERE v = 'b';").lost, ["`d` would lose 1 of its 2 rows", "1 fewer rows across its tables (2 before, 1 after)"], "1 and '1' read alike, each as often as before");
  assert.deepEqual(measured("CREATE TABLE n (k TEXT PRIMARY KEY, v); INSERT INTO n VALUES (NULL, 'a'), (NULL, 'b'), ('', 'c');", "UPDATE OR REPLACE n SET k = '' WHERE v = 'a';").lost, ["`n` would lose 1 of its 3 rows", "1 fewer rows across its tables (3 before, 2 after)"], "NULL keys aren't ''");
  assert.deepEqual(measured(runs(4, "notes"), "ALTER TABLE notes RENAME TO notes2; UPDATE OR REPLACE notes2 SET id = 'r1' WHERE id = 'r2'; CREATE TABLE labels (id TEXT PRIMARY KEY, km REAL); INSERT INTO labels VALUES ('r1', 1), ('r2', 2), ('r3', 3), ('r4', 4);").lost, ["`notes` would lose 1 of its 4 rows"], "a renamed table is followed by its page, not matched to a new one with the same key");
  assert.deepEqual(measured("CREATE VIRTUAL TABLE search USING fts5(body); CREATE TABLE search_history (id TEXT PRIMARY KEY); INSERT INTO search_history VALUES ('a'), ('b');", "UPDATE search_history SET id = id || '-x';").lost, ["`search_history` would lose 2 of its 2 rows (their keys change)"], "a table named like the FTS index is measured");
  assert.deepEqual(measured("CREATE TABLE r (v); INSERT INTO r VALUES ('a'), ('b'), ('c'); DELETE FROM r WHERE v = 'a'; INSERT INTO r VALUES ('d');", "ALTER TABLE r RENAME TO r_v1; CREATE TABLE r (v); INSERT INTO r (v) SELECT v FROM r_v1;").lost, [], "a table without a key rebuilt, its rowids renumbered: counted");
  assert.deepEqual(measured("CREATE TABLE p (id INT PRIMARY KEY, v); INSERT INTO p VALUES (1, 'a'), (2, 'b');", "ALTER TABLE p RENAME TO p_v1; CREATE TABLE p (id REAL PRIMARY KEY, v); INSERT INTO p SELECT * FROM p_v1;").lost, [], "whole numbers keep their keys as REAL");
});

test("a read's ids are compared up to 10,000", () => {
  assert.equal(idsIn({ items: Array.from({ length: 12_000 }, (_, i) => ({ id: i })) }).size, 10_000);
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

describe("the no-loss check, after review", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());
  const run = (km: number, notes?: string) => t.platform.invoke(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: km, durationSeconds: 1500, date: "2026-10-01", ...(notes ? { notes } : {}) } });
  const change = async (edit: (ws: string) => void, by = USER) => {
    t.queue(edit);
    return t.platform.settle((await t.platform.modify(by, { capabilityId: "running-log", request: "change" })).buildId);
  };
  /** The running log with one read more (its manifest entry and its code). */
  const withRead = (name: string, code: string) => (ws: string) => {
    editJson(join(ws, "capability.json"), (m) => m.operations.push({ name, description: name, version: 1, sideEffect: "read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }));
    editText(join(ws, "src/index.ts"), (s) => s.replace(/\n};\s*$/, `\n  ${code}\n};\n`));
  };
  const all = (...edits: ((ws: string) => void)[]) => (ws: string) => edits.forEach((e) => e(ws));

  test("an agent's build is told only that rows would be lost: which and how many are in the owner's build log", async () => {
    for (const km of [3, 4, 8]) await run(km);
    const b = await change(migration(rebuild(" WHERE NOT (distance_km < 5 AND date = '2026-10-01')")), t.claude);
    assert.equal(b.status, "failed", b.log.join("\n"));
    const log = b.log.join("\n");
    assert.match(log, /the migrations would lose data on a copy of the tool's data: rows gone or their keys changed/);
    assert.doesNotMatch(log, /`runs`|would lose \d|of its \d|rows kept/);
    assert.deepEqual([b.failure?.title, b.failure?.caught], ["Stopped before it went live", true]);
    assert.match((await t.platform.workbench.transcript(b.buildId)) ?? "", /`runs` would lose 2 of its 3 rows/);
    const kept = await change(migration("ALTER TABLE runs ADD COLUMN shoes TEXT;\n", "002_shoes.sql"), t.claude);
    assert.ok(kept.log.some((l) => /no data lost by the migrations on a copy of the tool's data$/.test(l)), kept.log.join("\n"));
  });

  test("the old version's reads run read-only: one that writes is left out, not blamed on the migration", async () => {
    const v2 = await change(all(migration("CREATE TABLE cache (id TEXT PRIMARY KEY);\nINSERT INTO cache VALUES ('c1');\n", "002_cache.sql"), withRead("peek", `"peek@1"(_: unknown, { db }: Ctx) { db.prepare("DELETE FROM cache").run(); return {}; },`)));
    assert.equal(v2.status, "promoted", v2.log.join("\n"));
    const b = await change(migration("ALTER TABLE runs ADD COLUMN shoes TEXT;\n", "003_shoes.sql"));
    assert.equal(b.status, "promoted", b.log.join("\n"));
  });

  test("a read that worked before and fails after the migrations stops the build", async () => {
    await run(5, "boom");
    const b = await change(all(migration("ALTER TABLE runs ADD COLUMN shoes TEXT;\n", "002_shoes.sql"), (ws) => editText(join(ws, "src/index.ts"), (s) => s.replace(`"get_summary@1"(input: Range, { db }: Ctx) {`, `"get_summary@1"(input: Range, { db }: Ctx) {\n    if (db.prepare("SELECT 1 FROM runs WHERE notes = 'boom'").get()) throw new Error("bad row");`))));
    assert.equal(b.status, "failed", b.log.join("\n"));
    assert.match(b.log.join("\n"), /- get_summary@1 fails after the migrations: get_summary@1 failed: bad row/);
    assert.equal(b.failure?.caught, true);
  });

  test("reads that pick at random or show the latest one don't fail a change that adds rows", async () => {
    for (const km of [3, 4]) await run(km);
    const v2 = await change(all(withRead("pick", `"pick@1"(_: unknown, { db }: Ctx) { return { runs: db.prepare("SELECT id FROM runs ORDER BY random() LIMIT 1").all() }; },`), withRead("latest", `"latest@1"(_: unknown, { db }: Ctx) { return { runs: db.prepare("SELECT id FROM runs ORDER BY date DESC, recorded_at DESC LIMIT 1").all() }; },`)));
    assert.equal(v2.status, "promoted", v2.log.join("\n"));
    for (let i = 0; i < 3; i++) {
      const b = await change(migration(`INSERT INTO runs (id, date, distance_km, duration_seconds, notes, recorded_at) SELECT 'seeded-${i}', '2099-01-0${i + 1}', 1, 60, NULL, '2099-01-01T00:00:00Z' WHERE EXISTS (SELECT 1 FROM runs);\n`, `00${i + 2}_seed.sql`));
      assert.equal(b.status, "promoted", b.log.join("\n"));
    }
  });

  test("an agent's build isn't told which read failed after the migrations, nor its error: the owner's build log has them", async () => {
    await run(5, "boom");
    const b = await change(all(migration("ALTER TABLE runs ADD COLUMN shoes TEXT;\n", "002_shoes.sql"), (ws) => editText(join(ws, "src/index.ts"), (s) => s.replace(`"get_summary@1"(input: Range, { db }: Ctx) {`, `"get_summary@1"(input: Range, { db }: Ctx) {\n    if (db.prepare("SELECT 1 FROM runs WHERE notes = 'boom'").get()) throw new Error("bad row");`))), t.claude);
    assert.equal(b.status, "failed", b.log.join("\n"));
    assert.doesNotMatch(b.log.join("\n"), /bad row|get_summary@1 fails|boom/);
    assert.match(b.log.join("\n"), /rows gone or their keys changed, or a read that fails or returns fewer records/);
    assert.match((await t.platform.workbench.transcript(b.buildId)) ?? "", /get_summary@1 fails after the migrations: get_summary@1 failed: bad row/);
  });

  test("an FTS index rewritten by a migration isn't lost data", async () => {
    for (const km of [3, 4]) await run(km, `run ${km}`);
    const v2 = await change(migration("CREATE VIRTUAL TABLE notes_fts USING fts5(body);\nINSERT INTO notes_fts (body) SELECT coalesce(notes, '') FROM runs;\n", "002_fts.sql"));
    assert.equal(v2.status, "promoted", v2.log.join("\n"));
    const b = await change(migration("INSERT INTO notes_fts(notes_fts) VALUES('optimize');\n", "003_optimize.sql"));
    assert.equal(b.status, "promoted", b.log.join("\n"));
  });

  test("an agent's builder checks its work on sample data: only each attempt's validation meets the owner's", async () => {
    const validation = (t.platform as any).d.validation as Validation;
    const seen: unknown[] = [];
    validation.check = async (_b, opts = {}) => {
      seen.push(opts);
      return { passed: true, text: "PASS", failures: [], warnings: [], defects: [], images: [] };
    };
    for (const requestedBy of [t.claude.id, USER.id]) {
      const checks = validation.checksFor({ id: "b", capabilityId: "running-log", requestedBy } as any, new AbortController().signal, () => {});
      await checks.run("c1");
      await checks.settled();
    }
    assert.deepEqual(seen, [{ liveData: false }, {}]);
  });

  test("a migration that doesn't apply to the old version's sample data (a client's check) says so, and isn't caught", async () => {
    const pack = await t.platform.pack(t.claude, { kind: "modify", capabilityId: "running-log" });
    const files = pack.files.filter((f) => !/^(CONTRACTS\.md|OTHER_TOOLS\.md|PLATFORM_UI\.css|\.hewn-contracts\/)/.test(f.path));
    const checked = await t.platform.checkFiles(t.claude, { files: [...files, { path: "migrations/002_one_a_day.sql", content: "CREATE UNIQUE INDEX one_a_day ON runs (date);\n" }], capabilityId: "running-log" });
    assert.equal(checked.passed, false, checked.text);
    assert.match(checked.failures.join("\n"), /the upgrade dry run failed on its sample data in the version it replaces: .*UNIQUE/);
  });
});

test("caught: what the copy stopped for the tool's data, and what it didn't", () => {
  const f = (msg: string) => explainFailure([`FAILED: ${msg}`]);
  assert.deepEqual([f("the upgrade dry run failed: UNIQUE constraint failed: runs.date").detail, f("the upgrade dry run failed: x").caught], ["A migration didn't apply to the data the tool holds now: UNIQUE constraint failed: runs.date", true]);
  assert.equal(f(DRY_RUN_FAILED).caught, true);
  assert.equal(f(NO_LOSS_FAILED).caught, true);
  assert.equal(f("record_run@1 leaves runs with fewer rows and adds none: declare it destructive").caught, true);
  const sample = f("the upgrade dry run failed on its sample data in the version it replaces: UNIQUE constraint failed: runs.date");
  assert.deepEqual([sample.title, sample.detail, sample.caught], ["A migration didn't apply", "To the tool's sample data: UNIQUE constraint failed: runs.date", undefined]);
});

test("the migration lint reads past comments, and a '--' in a string doesn't hide what follows", () => {
  const lint = (sql: string) => migrationProblems([{ name: "002_x.sql", sql }], []);
  assert.match(lint("DELETE/**/FROM runs;").join(), /destructive/);
  assert.match(lint("INSERT INTO notes VALUES ('--'); DELETE FROM runs;").join(), /destructive/);
  assert.match(lint("INSERT INTO notes VALUES ('--'); DELETE/**/FROM runs;").join(), /destructive/);
  assert.match(lint("SELECT '--'; DROP/**/TABLE runs;").join(), /destructive/);
  assert.match(lint("UPDATE _hewn_keys_before SET k = '1';").join(), /_hewn_ in them are Hewn's own/, "the no-loss check's snapshot is out of reach");
  assert.match(lint('CREATE TABLE "_HEWN_KEYS_BEFORE_k" (x);').join(), /_hewn_ in them are Hewn's own/);
  assert.deepEqual(lint("INSERT INTO t VALUES ('/* not a comment */');"), []);
  assert.deepEqual(lint("-- shoes per run\nALTER TABLE runs ADD COLUMN shoes TEXT;"), []);
});

test("purging a tool forgets which of its operations stalled", async () => {
  const t = setup();
  try {
    await installSeed(t.platform);
    t.platform.registry.setKv("stalled-ops:running-log", ["list_runs@1"]);
    t.platform.registry.purgeCapability("running-log");
    assert.equal(t.platform.registry.getKv("stalled-ops:running-log"), undefined);
  } finally {
    t.cleanup();
  }
});
