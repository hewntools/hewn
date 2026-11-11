// SPDX-License-Identifier: AGPL-3.0-or-later
// Each tool's data has a size limit, on the real workerd host: a write past it fails and reading still works,
// the setting (and a tool's own) changes it, the tool's own code can't lift it, it holds while a tool installs,
// and nothing grows while the disk is nearly full.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

const CLI = join(import.meta.dirname, "..", "packages", "cli", "src", "cli.ts");
const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A tool that stores blobs of random bytes, and tries from its own code to lift its limit (`escape`). */
const FILLER = `
type Db = { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): any } };
const tried = (fn: () => unknown) => {
  try {
    fn();
    return "ran";
  } catch (e) {
    return "refused: " + (e as Error).message;
  }
};
const count = (db: Db) => db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(length(data)), 0) AS bytes FROM blobs").get();
/** The facet's own state object, taken by patching the runtime module (what any tool's code can do). */
let leaked: any;
/** Before any facet starts here: a look-alike state handed to the guard, to plant a setter of its own. */
const lookAlike = () => ({ storage: { sql: Object.create({ setMaxPageCountForTest() {} }) } });
let planted = "not yet";
import(["./hewn", "guard.js"].join("-")).then(
  (guard) => (planted = tried(() => guard.lockStorage(lookAlike()))),
  (e) => (planted = "no import: " + e.message),
);

export const operations = {
  "add@1"(input: { kb: number; rows: number }, { db }: { db: Db }) {
    const insert = db.prepare("INSERT INTO blobs (data) VALUES (randomblob(?))");
    for (let i = 0; i < input.rows; i++) insert.run(input.kb * 1024);
    return count(db);
  },
  "count@1"(_: unknown, { db }: { db: Db }) {
    return count(db);
  },
  "clear@1"(_: unknown, { db }: { db: Db }) {
    db.exec("DELETE FROM blobs");
    return count(db);
  },
  async "escape@1"(input: { mb?: number }, { db }: { db: Db }) {
    if (!leaked) {
      const runtime = await import(["./hewn", "runtime.js"].join("-"));
      const original = runtime.Capability.prototype.db;
      runtime.Capability.prototype.db = function (this: { ctx: unknown }) {
        leaked = this.ctx;
        return original.call(this);
      };
      return { leaked: false };
    }
    const sql = leaked.storage.sql;
    if (input.mb) {
      // Whatever setter it can find first, then straight into its SQLite, past the db facade.
      tried(() => sql.setMaxPageCountForTest(1_000_000_000));
      tried(() => db.exec("PRAGMA max_page_count = 1000000000"));
      for (let i = 0; i < input.mb * 16; i++) sql.exec("INSERT INTO blobs (data) VALUES (randomblob(65536))");
      return { leaked: true, ...count(db) };
    }
    const guard = await import(["./hewn", "guard.js"].join("-"));
    return {
      leaked: true,
      setMax: typeof sql.setMaxPageCountForTest,
      onPrototype: typeof Object.getPrototypeOf(sql).setMaxPageCountForTest,
      ingest: typeof sql.ingest,
      facets: typeof leaked.facets,
      pragma: tried(() => db.exec("PRAGMA max_page_count = 1000000000")),
      pragmaDirect: tried(() => sql.exec("PRAGMA max_page_count = 1000000000").toArray()),
      planted,
      lookAlike: tried(() => guard.lockStorage(lookAlike())),
      again: tried(() => guard.lockStorage(leaked)),
    };
  },
};
`;

const op = (name: string, sideEffect: string, properties: Record<string, unknown> = {}) => ({
  name,
  description: name,
  version: 1,
  sideEffect,
  inputSchema: { type: "object", additionalProperties: false, properties },
  outputSchema: { type: "object" },
});

/** A tool's files in a folder of their own, for `hewn install <dir>`. */
function toolDir(root: string, id: string, name: string, cases: unknown[]): string {
  const dir = join(root, id);
  for (const d of ["src", "migrations", "tests"]) mkdirSync(join(dir, d), { recursive: true });
  const blobs = { kb: { type: "integer", minimum: 1 }, rows: { type: "integer", minimum: 1 } };
  writeFileSync(
    join(dir, "capability.json"),
    JSON.stringify({ id, name, purpose: "Stores blobs.", description: "Stores blobs of random bytes.", abi: "2.0", operations: [op("add", "write", blobs), op("count", "read"), op("clear", "write"), op("escape", "write", { mb: { type: "integer" } })] }, null, 2),
  );
  writeFileSync(join(dir, "migrations", "001_init.sql"), "CREATE TABLE blobs (id INTEGER PRIMARY KEY, data BLOB NOT NULL);\n");
  writeFileSync(join(dir, "src", "index.ts"), FILLER);
  writeFileSync(join(dir, "tests", "cases.json"), JSON.stringify(cases));
  return dir;
}

const until = async (fn: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe("each tool's data has a size limit (workerd)", () => {
  let h: TestHost;
  let dirs: string;
  /** The disk the supervisor sees, and how many times it has looked. */
  let disk = { free: 10 * GB, total: 100 * GB };
  let looks = 0;
  const add = (kb: number, rows: number) => h.invoke("filler", "add", { kb, rows }).then((r) => r.result);
  const count = () => h.invoke("filler", "count").then((r) => r.result as { rows: number; bytes: number });
  const failure = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
  /** The real CLI, against this host. */
  const hewn = (...a: string[]) =>
    new Promise<string>((resolve, reject) =>
      execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...a], { env: { ...process.env, HEWN_HOME: h.root } }, (e, out, err) => (e ? reject(new Error(`hewn ${a.join(" ")}: ${err || out}`)) : resolve(out))),
    );

  before(async () => {
    h = await startTestHost({ disk: { space: () => (looks++, disk), intervalMs: 100 } });
    writeFileSync(join(h.root, "supervisor.json"), JSON.stringify({ url: h.sv.url, adminToken: h.sv.adminToken, control: h.sv.control, pid: process.pid }));
    dirs = mkdtempSync(join(tmpdir(), "hewn-limit-"));
    await h.sv.admin("settings", { toolDataLimitMB: 2 });
    const build = await h.sv.admin("install", { name: "Filler", purpose: "blobs", dir: toolDir(dirs, "filler", "Filler", [{ name: "count", operation: "count", input: {}, expect: { rows: 0 } }]), wait: true });
    assert.equal(build.status, "promoted", build.log.join("\n"));
  });
  after(async () => {
    await h?.stop();
    rmSync(dirs, { recursive: true, force: true });
  });

  test("a tool writing past its limit is stopped near it, says why, and can still read", async () => {
    assert.equal((await add(64, 16)).bytes, MB);
    // 2 MB more in one call: refused whole.
    assert.match(await failure(add(64, 32)), /^Filler's data is at its 2 MB limit, so it can't save more\. The limit is in Settings › Data\.$/);
    assert.equal((await count()).bytes, MB, "nothing of the refused call was kept, and reading works");
    // One row at a time, up to the limit.
    let refused = "";
    for (let i = 0; i < 40 && !refused; i++) refused = await failure(add(64, 1));
    assert.match(refused, /data is at its 2 MB limit/);
    const { bytes } = await count();
    assert.ok(bytes > 1.6 * MB && bytes <= 2 * MB, `stopped near 2 MB: ${bytes}`);
    // The owner sees why in the tool's log.
    const { lines } = await h.sv.admin("logs", { capabilityId: "filler", n: 5 });
    assert.ok(lines.some((l: string) => /ERROR operation_failed: Filler's data is at its 2 MB limit/.test(l)), lines.join("\n"));
  });

  test("the setting changes the limit, and a tool can have its own", async () => {
    assert.match(await hewn("data", "limit", "4"), /^Each tool's data: up to 4 MB\n$/);
    assert.ok((await add(64, 16)).bytes > 2.7 * MB, "1 MB more fits under 4 MB");
    // Its own limit, below what it holds: it keeps its data and can't grow, but can reuse what it frees.
    assert.match(await hewn("data", "limit", "filler", "1"), /up to 4 MB\n  filler: up to 1 MB\n$/);
    assert.match(await failure(add(64, 16)), /^Filler's data is at its 1 MB limit/);
    assert.ok((await count()).bytes > 2.7 * MB, "its data is kept");
    await h.invoke("filler", "clear");
    assert.equal((await add(64, 4)).bytes, 256 * 1024);
    assert.match(await hewn("data", "limit", "filler", "default"), /^Each tool's data: up to 4 MB\n$/);
    await h.sv.admin("settings", { toolDataLimitMB: 2 });
    await h.invoke("filler", "clear");
    for (const bad of [{ toolDataLimitMB: 0 }, { toolDataLimitMB: 1.5 }, { toolDataLimitsMB: { "Not an id": 5 } }, { toolDataLimitsMB: { filler: 0 } }]) await assert.rejects(h.sv.admin("settings", bad), /toolDataLimit/);
    await assert.rejects(hewn("data", "limit", "lots"), /toolDataLimitMB must be a whole number of MB/);
  });

  test("the tool's own code can't lift its limit", async () => {
    assert.deepEqual((await h.invoke("filler", "escape")).result, { leaked: false });
    // It holds its facet's state object now: 4 MB, after trying to lift the limit.
    assert.match(await failure(h.invoke("filler", "escape", { mb: 4 })), /data is at its 2 MB limit/);
    assert.ok((await count()).bytes <= 2 * MB);
    const seen = (await h.invoke("filler", "escape")).result;
    assert.equal(seen.leaked, true);
    assert.equal(seen.setMax, "undefined");
    assert.equal(seen.onPrototype, "undefined");
    assert.equal(seen.ingest, "undefined");
    assert.equal(seen.facets, "undefined");
    assert.match(seen.pragma, /^refused: not authorized/);
    assert.match(seen.pragmaDirect, /^refused: not authorized/);
    assert.match(seen.planted, /^refused: .*DurableObjectState/);
    assert.match(seen.lookAlike, /^refused: .*DurableObjectState/);
    assert.equal(seen.again, "ran");
  });

  test("while a tool installs: tests that write past the limit fail the build", async () => {
    const dir = toolDir(dirs, "hoarder", "Hoarder", [{ name: "3 MB", operation: "add", input: { kb: 64, rows: 48 }, expect: { rows: 48 } }]);
    const build = await h.sv.admin("install", { name: "Hoarder", purpose: "blobs", dir, wait: true });
    assert.notEqual(build.status, "promoted");
    assert.match(build.log.join("\n"), /data is at its 2 MB limit/);
  });

  test("a nearly full disk: tools can't add data, can read, and can again once there's room", async () => {
    // A limit out of the way; 4 MB a call is more than the room its earlier rows left in its file.
    await h.sv.admin("settings", { toolDataLimitMB: 50 });
    disk = { free: 512 * MB, total: 100 * GB };
    let refused = "";
    await until(async () => /the disk/.test((refused = await failure(add(64, 64)))));
    assert.equal(refused, "Filler can't save more: the disk with Hewn's data has less than 1 GB free.");
    const before = await count();
    assert.equal(typeof before.rows, "number", "reading works");
    disk = { free: 10 * GB, total: 100 * GB };
    await until(async () => !(await failure(add(64, 64))));
    assert.equal((await count()).rows, before.rows + 64);
  });

  test("a small disk: the floor is a tenth of it, so a disk under 1 GB still takes data", async () => {
    disk = { free: 200 * MB, total: 512 * MB };
    const seen = looks;
    await until(async () => looks >= seen + 3); // two whole checks of this disk
    const before = (await count()).rows;
    assert.equal((await add(64, 16)).rows, before + 16, "200 MB free of 512 MB is room");
    disk = { free: 40 * MB, total: 512 * MB };
    let refused = "";
    await until(async () => /the disk/.test((refused = await failure(add(64, 64)))));
    assert.equal(refused, "Filler can't save more: the disk with Hewn's data has less than 51 MB free.");
    disk = { free: 10 * GB, total: 100 * GB };
  });
});
