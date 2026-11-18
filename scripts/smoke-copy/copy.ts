// SPDX-License-Identifier: AGPL-3.0-or-later
// A throwaway copy of someone's Hewn for a smoke run: restored from a `hewn backup` zip (or snapshotted from a home
// the way the nightly backup does) into a fresh home, then made safe before anything starts on it. Every step fails
// closed: when one can't be done, or can't be checked afterwards, the copy isn't started.
//
// - No secrets: the encrypted secrets go (the copy gets a key of its own anyway, so they couldn't be read), and so do
//   agents' and the web client's tokens (hashes only, but the copy has no use for them). Without them a connection's
//   sign-in is gone, so it can't refresh a token and sign the live Hewn out of a service.
// - No schedules: every active schedule is paused in SQLite before Hewn starts, and none may be left active. The
//   copy also starts with HEWN_SCHEDULES=off; the paused rows hold even if that switch ever stopped working.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupNow, restoreBackup } from "../../packages/cli/src/backup.ts";
import type { Home } from "../../packages/cli/src/home.ts";

/** Tables whose rows a copy never keeps: the owner's secrets (ciphertext), and sign-in tokens (hashes). */
export const STRIPPED_TABLES = ["secrets_enc", "oauth_tokens", "web_sessions"] as const;

export interface CopyFacts {
  /** The copy's HEWN_HOME. */
  home: string;
  /** Where the copy's backups go (inside the work dir, never the owner's folder). */
  backupDir: string;
  source: "backup" | "home";
  /** SQLite files looked at. */
  databases: number;
  /** Schedules paused before start (all of them were active). */
  paused: number;
  /** Schedules in the copy, by status, after the pause. */
  schedules: Record<string, number>;
  /** Rows removed, by table. */
  stripped: Record<string, number>;
  /** Builds the copy holds as running (Hewn retries them at start, on the stub builder). */
  openBuilds: number;
  capabilities: number;
}

/** A Home for a path without making anything in it (openHome makes folders: never in a source). */
const homeAt = (root: string): Home => ({ root, db: join(root, "platform.db"), capabilities: join(root, "capabilities"), builds: join(root, "builds") });

/** Every SQLite file of a home's data: the workerd host's under workerd/do, and a Node host's platform.db. */
export function databases(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".sqlite")) out.push(p);
    }
  };
  const doDir = join(root, "workerd", "do");
  if (existsSync(doDir)) walk(doDir);
  if (existsSync(join(root, "platform.db"))) out.push(join(root, "platform.db"));
  return out.sort();
}

const tablesOf = (db: DatabaseSync) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String((r as { name: string }).name)));

/**
 * Make `home` (a copy's) safe to start: strip what a copy never keeps, pause every schedule, then check both took.
 * Throws when anything is off: then the copy must not start.
 */
export function makeSafe(home: string): Omit<CopyFacts, "home" | "backupDir" | "source"> {
  const files = databases(home);
  if (!files.length) throw new Error(`no databases in ${home}: nothing to start`);
  const stripped: Record<string, number> = {};
  const schedules: Record<string, number> = {};
  let paused = 0;
  let owner = 0;
  let openBuilds = 0;
  let capabilities = 0;
  for (const file of files) {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file);
    } catch (e) {
      throw new Error(`can't open ${file}: ${(e as Error).message}`);
    }
    try {
      const tables = tablesOf(db);
      for (const t of STRIPPED_TABLES) {
        if (!tables.has(t)) continue;
        stripped[t] = (stripped[t] ?? 0) + Number(db.prepare(`DELETE FROM ${t}`).run().changes);
      }
      if (tables.has("schedules")) paused += Number(db.prepare("UPDATE schedules SET status = 'paused' WHERE status = 'active'").run().changes);
      // Checked on the same file, after the writes: nothing active, nothing stripped left.
      if (tables.has("schedules")) {
        for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM schedules GROUP BY status").all() as { status: string; n: number }[]) schedules[r.status] = (schedules[r.status] ?? 0) + Number(r.n);
        const active = Number((db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'").get() as { n: number }).n);
        if (active) throw new Error(`${active} schedule(s) still active in ${file} after the pause`);
      }
      for (const t of STRIPPED_TABLES) {
        if (tables.has(t) && Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)) throw new Error(`${t} still has rows in ${file}`);
      }
      if (tables.has("capabilities")) {
        owner++;
        capabilities += Number((db.prepare("SELECT COUNT(*) AS n FROM capabilities WHERE archived_at IS NULL").get() as { n: number }).n);
        if (tables.has("builds")) openBuilds += Number((db.prepare("SELECT COUNT(*) AS n FROM builds WHERE status IN ('waiting', 'open', 'building', 'validating')").get() as { n: number }).n);
        // The owner's database must have had the tables the pause and the strip rely on: a home without them is
        // one this code doesn't understand, and starting it would be a guess.
        if (!tables.has("schedules") || !tables.has("secrets_enc")) throw new Error(`the owner's database ${file} has no ${!tables.has("schedules") ? "schedules" : "secrets_enc"} table: not a home this harness understands`);
      }
    } finally {
      db.close();
    }
  }
  if (owner !== 1) throw new Error(`expected one owner database in the copy, found ${owner}`);
  return { databases: files.length, paused, schedules, stripped, openBuilds, capabilities };
}

/**
 * A copy of `from` (a `hewn backup` zip, or a Hewn home: snapshotted as the nightly backup does, so a running Hewn's
 * data is read consistently and never written) in `work`/home, made safe. Its backups go to `work`/backups, with
 * today's already there (the copy's own, made after the strip), so the nightly one doesn't run during the checks.
 */
export function makeCopy(from: string, work: string, now = new Date()): CopyFacts {
  const src = resolve(from);
  if (!existsSync(src)) throw new Error(`nothing at ${src}`);
  const home = join(work, "home");
  const backupDir = join(work, "backups");
  if (existsSync(home) && readdirSync(home).length) throw new Error(`${home} isn't empty`);
  mkdirSync(join(home, "builds"), { recursive: true });
  let source: CopyFacts["source"];
  let zip: string;
  if (statSync(src).isDirectory()) {
    if (!existsSync(join(src, "workerd", "do"))) throw new Error(`${src} isn't a Hewn home (no workerd/do): give a backup zip or a home`);
    if (resolve(work).startsWith(src + "/")) throw new Error("the work dir can't be inside the home it copies");
    source = "home";
    // Only do/ and blobs/ are read (as a backup); never the home's master.key, platform.json, tunnel or builds.
    zip = backupNow(homeAt(src), join(work, "snapshot"), now).file;
  } else {
    source = "backup";
    zip = src;
  }
  const restored = restoreBackup(homeAt(home), zip);
  if (restored.kind !== "workerd") throw new Error("a backup of the Node test host: only the workerd host's backups can be started");
  rmSync(restored.aside, { recursive: true, force: true });
  if (source === "home") rmSync(join(work, "snapshot"), { recursive: true, force: true });
  // Nothing of the source's own outside do/ and blobs/ (a master key, its settings file, a tunnel).
  for (const f of ["master.key", "platform.json", "tunnel.json", "supervisor.json"]) if (existsSync(join(home, f))) throw new Error(`the copy has the source's ${f}`);
  const facts = makeSafe(home);
  // The copy's settings file: only where its backups go.
  writeFileSync(join(home, "platform.json"), JSON.stringify({ backupDir }, null, 2) + "\n");
  backupNow(homeAt(home), backupDir, now);
  return { home, backupDir, source, ...facts };
}
