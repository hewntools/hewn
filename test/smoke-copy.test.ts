// SPDX-License-Identifier: AGPL-3.0-or-later
// The smoke harness's safety rules (scripts/smoke-copy): a copy of someone's Hewn has every schedule paused before it
// starts (or doesn't start), holds no secret or sign-in token, never takes a live Hewn's ports, and starts only on a
// tree that has the copy switches.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { backupNow, restoreBackup } from "@hewntools/cli/backup.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { databases, hewnDatabases, makeCopy, makeSafe } from "../scripts/smoke-copy/copy.ts";
import { assertSpare, copyPorts, LIVE_PORTS } from "../scripts/smoke-copy/ports.ts";
import { FIXTURES } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HARNESS = join(ROOT, "scripts", "smoke-copy");

/** The owner's database of a home (the one with a capabilities table). */
function ownerDb(root: string): string {
  return databases(root).find((f) => {
    const db = new DatabaseSync(f, { readOnly: true });
    try {
      return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'capabilities'").get();
    } finally {
      db.close();
    }
  })!;
}

/** A row with every NOT NULL column filled (text "x", numbers 0), and `values` over them. */
function insert(db: DatabaseSync, table: string, values: Record<string, string | number>) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; pk: number }[];
  const row: Record<string, string | number> = {};
  for (const c of cols) if (c.notnull || c.pk) row[c.name] = /INT/i.test(c.type) ? 0 : `x-${Math.random().toString(36).slice(2)}`;
  Object.assign(row, values);
  db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...Object.values(row));
}

const count = (file: string, sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } finally {
    db.close();
  }
};

describe("a copy for a smoke run", () => {
  let dir: string;
  /** A home as a live Hewn's: the 0.4.11 fixture with schedules (3 active), secrets and tokens added. */
  let source: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hewn-smoke-test-"));
    source = join(dir, "live");
    restoreBackup(openHome(source), join(FIXTURES, "home-0.4.11.zip"));
    const db = new DatabaseSync(ownerDb(source));
    for (const [id, status] of [["s1", "active"], ["s2", "active"], ["s3", "active"], ["s4", "paused"], ["s5", "proposed"]]) insert(db, "schedules", { id, status, capability_id: "runaway", operation: "tick", input: "{}", cadence: "hourly" });
    insert(db, "secrets_enc", { capability_id: "runaway", name: "API_KEY" });
    insert(db, "secrets_enc", { capability_id: "hewn:models", name: "anthropic" });
    for (const t of ["oauth_tokens", "web_sessions"]) insert(db, t, {});
    db.close();
    // A tool's own database with tables of the same names: the tool's data, never Hewn's.
    const own = new DatabaseSync(join(source, "workerd", "do", "hewn-capability", "own-tables.sqlite"));
    own.exec("CREATE TABLE schedules (id TEXT, status TEXT); INSERT INTO schedules VALUES ('mine', 'active'); CREATE TABLE web_sessions (id TEXT); INSERT INTO web_sessions VALUES ('kept')");
    own.close();
    // What else a live home has, which a copy must never get.
    writeFileSync(join(source, "master.key"), "the-live-key\n");
    writeFileSync(join(source, "platform.json"), JSON.stringify({ backupDir: join(dir, "owners-backups"), publicListen: "0.0.0.0" }));
    writeFileSync(join(source, "tunnel.json"), "{}");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("from a backup: every schedule paused before start, no secret or token left, its own key and backups", () => {
    const zip = backupNow(openHome(source), join(dir, "zips")).file;
    const work = join(dir, "work");
    const facts = makeCopy(zip, work);
    assert.equal(facts.paused, 3);
    assert.deepEqual(facts.schedules, { paused: 4, proposed: 1 });
    assert.deepEqual(facts.stripped, { secrets_enc: 2, oauth_tokens: 1, web_sessions: 1 });
    const owner = ownerDb(facts.home);
    assert.equal(count(owner, "SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'"), 0);
    for (const t of ["secrets_enc", "oauth_tokens", "web_sessions"]) assert.equal(count(owner, `SELECT COUNT(*) AS n FROM ${t}`), 0, t);
    assert.ok(!existsSync(join(facts.home, "master.key")), "the copy gets a key of its own at start, never the source's");
    assert.ok(!existsSync(join(facts.home, "tunnel.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(facts.home, "platform.json"), "utf8")), { backupDir: join(work, "backups") });
    assert.equal(readdirSync(join(work, "backups")).filter((f) => f.endsWith(".zip")).length, 1, "today's backup is there: the nightly one doesn't run");
    assert.ok(!existsSync(join(dir, "owners-backups")), "nothing went to the owner's backup folder");
    const own = join(facts.home, "workerd", "do", "hewn-capability", "own-tables.sqlite");
    assert.ok(!hewnDatabases(facts.home).includes(own) && databases(facts.home).includes(own));
    assert.equal(count(own, "SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'"), 1, "a tool's own table called schedules is its data: left as it is");
    assert.equal(count(own, "SELECT COUNT(*) AS n FROM web_sessions"), 1);
  });

  test("from a home: read as a backup reads it, never written; the copy is the same", () => {
    const before = Object.fromEntries(databases(source).map((f) => [f, readFileSync(f).toString("base64")]));
    const listing = readdirSync(source).sort();
    const facts = makeCopy(source, join(dir, "work"));
    assert.equal(facts.source, "home");
    assert.equal(facts.paused, 3);
    assert.equal(count(ownerDb(facts.home), "SELECT COUNT(*) AS n FROM secrets_enc"), 0);
    assert.ok(!existsSync(join(facts.home, "master.key")));
    assert.deepEqual(readdirSync(source).sort(), listing, "nothing made in the source");
    for (const [f, b64] of Object.entries(before)) assert.equal(readFileSync(f).toString("base64"), b64, `${f} unchanged`);
    assert.equal(count(ownerDb(source), "SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'"), 3, "the source's schedules untouched");
  });

  test("fails closed: a schedule that won't pause, or a home it doesn't understand, means no copy", () => {
    const stuck = join(dir, "stuck");
    restoreBackup(openHome(stuck), backupNow(openHome(source), join(dir, "zips")).file);
    const db = new DatabaseSync(ownerDb(stuck));
    db.exec("CREATE TRIGGER keep_active BEFORE UPDATE OF status ON schedules BEGIN SELECT RAISE(ABORT, 'no'); END");
    db.close();
    assert.throws(() => makeSafe(stuck), /no/);

    const noTable = join(dir, "no-table");
    restoreBackup(openHome(noTable), join(FIXTURES, "home-0.4.11.zip"));
    const d2 = new DatabaseSync(ownerDb(noTable));
    d2.exec("DROP TABLE schedules");
    d2.close();
    assert.throws(() => makeSafe(noTable), /no schedules table/);

    const broken = join(dir, "broken");
    restoreBackup(openHome(broken), join(FIXTURES, "home-0.4.11.zip"));
    writeFileSync(join(broken, "workerd", "do", "hewn-owner", "extra.sqlite"), "not a database");
    assert.throws(() => makeSafe(broken));
    assert.throws(() => makeCopy(join(dir, "nothing-here.zip"), join(dir, "w")), /nothing at/);
  });

  test("the harness stops before starting anything when the copy can't be made safe", () => {
    // A backup whose schedules can't be paused: the run ends, and no Hewn was ever started (no log, no stub).
    const stuck = join(dir, "stuck");
    restoreBackup(openHome(stuck), backupNow(openHome(source), join(dir, "zips")).file);
    const db = new DatabaseSync(ownerDb(stuck));
    db.exec("CREATE TRIGGER keep_active BEFORE UPDATE OF status ON schedules BEGIN SELECT RAISE(ABORT, 'pause refused'); END");
    db.close();
    const zip = backupNow({ root: stuck, db: "", capabilities: "", builds: "" }, join(dir, "stuck-zip")).file;
    const out = join(dir, "out");
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(HARNESS, "smoke-copy.ts"), "--from", zip, "--tree", ROOT, "--out", out], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(readFileSync(join(out, "report.md"), "utf8"), /Stopped early:\*\* .*pause refused/);
    assert.ok(!existsSync(join(out, "hewn.log")), "no Hewn started");
  });
});

describe("an interrupted run", () => {
  test("Ctrl-C while the copy starts: it's stopped, nothing of it left running, its home deleted, the report says so", async () => {
    const out = mkdtempSync(join(tmpdir(), "hewn-smoke-int-"));
    try {
      const run = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(HARNESS, "smoke-copy.ts"), "--from", join(FIXTURES, "home-0.4.11.zip"), "--tree", ROOT, "--out", out], { stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      const exited = new Promise<number | null>((r) => run.once("exit", (code) => r(code)));
      await new Promise<void>((ok, fail) => {
        const t = setTimeout(() => fail(new Error(`no start in 60 s:\n${text}`)), 60_000);
        run.stdout!.on("data", (b) => {
          text += b;
          if (text.includes("[smoke] starting")) {
            clearTimeout(t);
            ok();
          }
        });
      });
      const work = /copying .* into (\S+)/.exec(text)![1];
      run.kill("SIGINT");
      assert.equal(await exited, 130);
      assert.match(readFileSync(join(out, "report.md"), "utf8"), /Stopped early:\*\* interrupted \(SIGINT\)/);
      assert.ok(!existsSync(work), "the copy's home is gone");
      const ps = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout;
      assert.ok(!ps.includes(work.replace(/^\/var\//, "")), "nothing of the copy left running");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe("the copy's ports", () => {
  test("spare ones, never a live Hewn's (7717, 7718, 9091) nor next to one it's told of", async () => {
    const offered = [7717, 7718, 9091, 7727, 7728, 7717, 50001, 50001, 50002];
    const ports = await copyPorts(async () => offered.shift()!, [7727]);
    assert.deepEqual(ports, { port: 50001, publicPort: 50002 });
    for (const p of LIVE_PORTS) assert.throws(() => assertSpare([50001, p]), /a live Hewn's/);
    assert.throws(() => assertSpare([7727], [7727]));
    assertSpare([50001, 50002]);
  });
});

describe("the copy's Hewn", () => {
  test("won't start on a tree without the copy switches", () => {
    // A tree as one before HEWN_SCHEDULES / HEWN_NETWORK: its startSupervisor must never be reached.
    const fake = mkdtempSync(join(tmpdir(), "hewn-old-tree-"));
    try {
      const file = (p: string, text: string) => (mkdirSync(join(fake, p, ".."), { recursive: true }), writeFileSync(join(fake, p), text));
      file("packages/cli/src/supervisor/index.ts", `export const config = () => ""; export const toolsConfig = () => ""; export const supervisorFile = () => ""; export function startSupervisor() { console.log("STARTED"); }`);
      file("packages/cli/src/home.ts", "export const openHome = () => ({}); export const writeFileAtomic = () => {};");
      file("packages/cli/src/supervisor/format.ts", "export const writeFormat = () => {};");
      const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(HARNESS, "launch.ts")], {
        encoding: "utf8",
        timeout: 30_000,
        env: { PATH: process.env.PATH, SMOKE_TREE: fake, HEWN_HOME: fake, HEWN_PORT: "50001", SMOKE_PUBLIC_PORT: "50002", SMOKE_NETWORK: "off", SMOKE_STUB: join(fake, "stub.jsonl") },
      });
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.match(r.stderr, /SMOKE-UNSUPPORTED/);
      assert.doesNotMatch(r.stdout, /STARTED/);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  test("the harness is in the typecheck", () => {
    assert.match(readFileSync(join(ROOT, "tsconfig.json"), "utf8"), /"scripts\/smoke-copy"/);
  });
});
