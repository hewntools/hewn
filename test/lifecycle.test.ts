// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { USER } from "@hewntools/core/auth.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { editJson, editText, installSeed, setup } from "./helpers.ts";

const write = (path: string, content: string) => (mkdirSync(dirname(path), { recursive: true }), writeFileSync(path, content));
const backups = (t: ReturnType<typeof setup>, id: string) => (existsSync(join(t.home.capabilities, id, "backups")) ? readdirSync(join(t.home.capabilities, id, "backups")) : []);

const recordRun = (manifest: any) => manifest.operations.find((o: any) => o.name === "record_run" && o.version === 1);

describe("modification lifecycle", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
    await t.platform.invoke(t.claude, {
      capabilityId: "running-log",
      operation: "record_run",
      input: { distanceKm: 5, durationSeconds: 1680, date: "2026-10-03" },
    });
  });
  afterEach(() => t.cleanup());

  /** A compatible change: optional `location` on record_run@1, surfaced by list_runs@1. */
  function addLocation(ws: string) {
    editJson(join(ws, "capability.json"), (m) => {
      recordRun(m).inputSchema.properties.location = { type: "string" };
      m.operations.find((o: any) => o.name === "list_runs").outputSchema.properties.runs.items.properties.location = { type: "string" };
    });
    writeFileSync(join(ws, "migrations", "002_add_location.sql"), "ALTER TABLE runs ADD COLUMN location TEXT;\n");
    editText(join(ws, "src", "index.ts"), (s) =>
      s
        .replace("notes?: string }, { db }", "notes?: string; location?: string }, { db }")
        .replace("notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?)", "notes, recorded_at, location) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .replace("new Date().toISOString());", "new Date().toISOString(), input.location ?? null);")
        .replace("SELECT id, date, distance_km, duration_seconds, notes FROM", "SELECT id, date, distance_km, duration_seconds, notes, location FROM")
        .replace("notes: string | null }", "notes: string | null; location?: string | null }")
        .replace("...(r.notes !== null ? { notes: r.notes } : {}),", "...(r.notes !== null ? { notes: r.notes } : {}),\n        ...(r.location ? { location: r.location } : {}),"),
    );
    editJson(join(ws, "tests", "cases.json"), (cases) =>
      cases.push(
        { name: "location", operation: "record_run", input: { distanceKm: 1, durationSeconds: 300, date: "2027-01-01", location: "park" } },
        { name: "lists location", operation: "list_runs", input: { from: "2027-01-01" }, expect: { runs: [{ location: "park" }] } },
      ),
    );
  }

  test("compatible change becomes a new version; state and contract survive", async () => {
    let workspace = "";
    const done = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "add location" }),
      (ws) => ((workspace = ws), addLocation(ws)),
    );
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(!existsSync(workspace), "workspace cleaned up");
    assert.equal(backups(t, "running-log").length, 1, "state backed up before migration");

    const manifest = t.platform.get(t.codex, "running-log");
    assert.ok(recordRun(manifest).inputSchema.properties.location, "still record_run@1, now with location");

    await t.platform.invoke(t.codex, { capabilityId: "running-log", operation: "list_runs" }).then(({ result }) => {
      assert.equal((result as any).runs.length, 1, "run recorded under v1 survived");
    });
    await t.platform.invoke(t.claude, {
      capabilityId: "running-log",
      operation: "record_run",
      operationVersion: 1,
      input: { distanceKm: 2, durationSeconds: 600, location: "forest" },
    });
    const { result } = await t.platform.invoke(t.codex, { capabilityId: "running-log", operation: "list_runs" });
    assert.equal((result as any).runs[1].location, "forest");
  });

  test("breaking change to a published contract is rejected; active version keeps serving", async () => {
    const done = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "make notes required" }),
      (ws) => editJson(join(ws, "capability.json"), (m) => recordRun(m).inputSchema.required.push("notes")),
    );
    assert.equal(done.status, "failed");
    assert.match(done.log.join("\n"), /record_run@1 input \$\.notes: newly required/);

    await t.platform.invoke(t.codex, {
      capabilityId: "running-log",
      operation: "record_run",
      input: { distanceKm: 1, durationSeconds: 300 },
    });
  });

  test("breaking change as a new operation version is accepted; latest is default", async () => {
    const done = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "record_run@2 in meters" }),
      (ws) => {
        editJson(join(ws, "capability.json"), (m) => {
          const v2 = structuredClone(recordRun(m));
          v2.version = 2;
          v2.inputSchema.required = ["distanceMeters", "durationSeconds"];
          delete v2.inputSchema.properties.distanceKm;
          v2.inputSchema.properties.distanceMeters = { type: "integer", exclusiveMinimum: 0 };
          m.operations.push(v2);
        });
        editText(join(ws, "src", "index.ts"), (s) =>
          s.replace(
            '  "list_runs@1"',
            `  "record_run@2"(input: { distanceMeters: number; durationSeconds: number; date?: string; notes?: string }, ctx: Ctx) {
    const { distanceMeters, ...rest } = input;
    return operations["record_run@1"]({ ...rest, distanceKm: distanceMeters / 1000 }, ctx);
  },

  "list_runs@1"`,
          ),
        );
        editJson(join(ws, "tests", "cases.json"), (c) => {
          // Unpinned cases resolve to the latest contract; existing cases target @1.
          for (const x of c) x.version ??= 1;
          c.push({ name: "v2", operation: "record_run", version: 2, input: { distanceMeters: 1000, durationSeconds: 300 }, expect: { runId: "$any" } });
        });
      },
    );
    assert.equal(done.status, "promoted", done.log.join("\n"));

    const latest = await t.platform.invoke(t.codex, { capabilityId: "running-log", operation: "record_run", input: { distanceMeters: 3000, durationSeconds: 900 } });
    assert.equal(latest.operation, "record_run@2");
    const v1 = await t.platform.invoke(t.codex, { capabilityId: "running-log", operation: "record_run", operationVersion: 1, input: { distanceKm: 1, durationSeconds: 300 } });
    assert.equal(v1.operation, "record_run@1");
  });

  test("failing test case blocks promotion; the builder is re-run with the failure and fixes it", async () => {
    t.platform.maxBuildAttempts = () => 2;
    let feedback: string | undefined;
    const done = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "break summary" }),
      (ws) => editText(join(ws, "src", "index.ts"), (s) => s.replace("runCount: r.n,", "runCount: r.n + 1,")),
      (ws, job) => ((feedback = job.feedback), editText(join(ws, "src", "index.ts"), (s) => s.replace("runCount: r.n + 1,", "runCount: r.n,"))),
    );
    assert.match(feedback ?? "", /test 'empty summary'/, "second attempt sees the failure");
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.match(done.log.join("\n"), /attempt 1: FAILED: 2 of 8 test cases failed[\s\S]*test 'empty summary'/);
  });

  test("destructive or rewritten migrations are rejected", async () => {
    const r1 = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "drop" }),
      (ws) => write(join(ws, "migrations", "002_reset.sql"), "DROP TABLE runs;"),
    );
    assert.equal(r1.status, "failed");
    assert.match(r1.log.join("\n"), /destructive/);

    const r2 = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "rewrite" }),
      (ws) => editText(join(ws, "migrations", "001_init.sql"), (s) => s + "\n-- edited"),
    );
    assert.equal(r2.status, "failed");
    assert.match(r2.log.join("\n"), /append-only/);
  });

  test("implementation must export every declared operation", async () => {
    const r = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "running-log", request: "x" }),
      (ws) => editText(join(ws, "src", "index.ts"), (s) => s.replace('"get_summary@1"', '"get_summary_typo@1"')),
    );
    assert.equal(r.status, "failed");
    assert.match(r.log.join("\n"), /get_summary@1/);
  });

  test("a build is rejected if the capability changed while it ran (a rollback)", async () => {
    await t.build(() => t.platform.modify(t.claude, { capabilityId: "running-log", request: "a" }), () => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.queue(() => gate);
    const stale = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "b" });
    await t.platform.rollback(USER, "running-log");
    release();
    const done = await t.platform.settle(stale.buildId);
    assert.equal(done.status, "failed");
    assert.match(done.log.join("\n"), /changed since this build started/);
  });

  test("changes to one capability take turns: each starts from what the one before it left", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const mark = (n: string) => (ws: string) => (seen.push(readFileSync(join(ws, "src", "index.ts"), "utf8")), editText(join(ws, "src", "index.ts"), (s) => `${s}\n// ${n}`));
    t.queue(async (ws) => (await gate, mark("first")(ws)), mark("second"), mark("third"));
    const first = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "a" });
    const second = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "b" });
    const third = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "c" });
    assert.equal(second.status, "waiting");
    assert.equal(second.dependsOn, first.buildId);
    assert.equal(second.queued, true);
    assert.match(second.instructions!, /the change to the same capability before it/);
    assert.equal(third.dependsOn, second.buildId, "in the order asked");
    release();
    for (const b of [first, second, third]) assert.equal((await t.platform.settle(b.buildId)).status, "promoted");
    assert.equal(t.platform.registry.getBuild(third.buildId)!.resultVersion, 4);
    assert.match(seen[2], /\/\/ first\n\/\/ second$/, "the third built on the first two");
  });

  test("a change queued behind one that fails starts anyway, from the active version", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.queue(async (ws) => (await gate, writeFileSync(join(ws, "capability.json"), "{ not json")), () => {});
    const first = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "a" });
    const second = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "b" });
    assert.equal(second.status, "waiting");
    release();
    assert.equal((await t.platform.settle(first.buildId)).status, "failed");
    const done = await t.platform.settle(second.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(done.resultVersion, 2);
  });
});

describe("creation lifecycle", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("create reserves identity; capability is invisible until promoted", async () => {
    let brief = false;
    const empty = await t.build(
      () => t.platform.create(t.claude, { name: "Reading List", purpose: "Track books", requirements: "add and list books" }),
      (ws) => void (brief = existsSync(join(ws, "BUILDER.md"))),
    );
    assert.equal(empty.capabilityId, "reading-list");
    assert.ok(brief, "the builder gets BUILDER.md");
    assert.equal(empty.status, "failed", "skeleton has no operations");
    assert.deepEqual(t.platform.list(t.codex), []);

    const ok = await t.build(
      () => t.platform.retryBuild(t.claude, empty.buildId),
      (ws) => {
        editJson(join(ws, "capability.json"), (m) => {
          m.operations = [
            {
              name: "add_book",
              description: "Add a book",
              version: 1,
              sideEffect: "write",
              inputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
              outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } },
            },
          ];
        });
        write(join(ws, "migrations", "001_init.sql"), "CREATE TABLE books (title TEXT NOT NULL);");
        write(
          join(ws, "src", "index.ts"),
          `export const operations = {
  "add_book@1"(input: { title: string }, { db }: { db: any }) {
    db.prepare("INSERT INTO books (title) VALUES (?)").run(input.title);
    return { count: (db.prepare("SELECT COUNT(*) AS n FROM books").get() as any).n };
  },
};
`,
        );
        write(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "adds", operation: "add_book", input: { title: "Dune" }, expect: { count: 1 } }]));
      },
    );
    assert.equal(ok.status, "promoted", ok.log.join("\n"));
    const { result } = await t.platform.invoke(t.codex, { capabilityId: "reading-list", operation: "add_book", input: { title: "Emma" } });
    assert.deepEqual(result, { count: 1 }, "live state is separate from test state");
  });

  test("duplicate id is a conflict", async () => {
    t.queue(() => new Promise(() => {}));
    await t.platform.create(t.claude, { name: "Reading List", purpose: "x", requirements: "x" });
    await assert.rejects(t.platform.create(t.claude, { name: "reading list!", purpose: "x", requirements: "x" }), /already exists/);
  });
});
