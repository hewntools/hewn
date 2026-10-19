// SPDX-License-Identifier: AGPL-3.0-or-later
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Home } from "./home.ts";
import { createZip, readZip, type ZipEntry } from "./zip.ts";

/**
 * Backups: one zipped snapshot of the platform home per day. Never secrets in plain text: the
 * workerd host stores them encrypted and the key stays outside the backup (Keychain / libsecret /
 * master.key); the Node host keeps them in the Keychain. Agent tokens are only ever stored as hashes.
 *
 * Written next to the platform home: ~/hewn/data backs up to ~/hewn/backups, any other home to
 * <home>-backups (so two homes in one folder never share, overwrite or prune each other's). `backupDir` in platform.json (or Settings) points it anywhere, e.g. a synced folder. Kept: 7 daily, 4 weekly.
 */

export const BACKUP_NAME = /^hewn-backup-(\d{4}-\d{2}-\d{2})\.zip$/;
const FORMAT = 1;

export interface BackupInfo {
  file: string;
  name: string;
  /** YYYY-MM-DD (local) */
  date: string;
  bytes: number;
  at: string;
}

/** Where backups go: `backupDir` from platform.json, else next to the home (see above). */
export function backupLocation(home: Home, configured?: string): { dir: string } {
  if (configured) return { dir: configured };
  const name = basename(home.root);
  return { dir: join(dirname(home.root), name === "data" ? "backups" : `${name}-backups`) };
}

/**
 * Whether backups in `dir` land on the same disk as the data in `root` (a disk failure takes both).
 * Compares device ids; a folder that doesn't exist yet is judged by its nearest existing parent. null: can't tell.
 */
export function sameDisk(root: string, dir: string): boolean | null {
  try {
    let d = dir;
    while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
    return statSync(root).dev === statSync(d).dev;
  } catch {
    return null;
  }
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: BACKUP_NAME.exec(name) }))
    .filter((x) => x.m)
    .map(({ name, m }) => {
      const st = statSync(join(dir, name));
      return { file: join(dir, name), name, date: m![1], bytes: st.size, at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** ISO week key, e.g. "2026-W41". */
function isoWeek(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Which backups retention keeps: the 7 newest days, then the newest of each of the 4 weeks before. */
export function retained(dates: string[]): Set<string> {
  const sorted = [...new Set(dates)].sort().reverse();
  const keep = new Set(sorted.slice(0, 7));
  const weeks = new Set<string>();
  for (const d of sorted.slice(7)) {
    const w = isoWeek(d);
    if (weeks.has(w) || weeks.size >= 4) continue;
    weeks.add(w);
    keep.add(d);
  }
  return keep;
}

export function prune(dir: string): string[] {
  const all = listBackups(dir);
  const keep = retained(all.map((b) => b.date));
  const removed = all.filter((b) => !keep.has(b.date));
  for (const b of removed) rmSync(b.file, { force: true });
  return removed.map((b) => b.name);
}

/** A consistent copy of a SQLite file (safe while it's open elsewhere, WAL included). */
function snapshotDb(path: string): Buffer {
  const tmp = join(mkdtempSync(join(tmpdir(), "hewn-snap-")), "db");
  try {
    const db = new DatabaseSync(path);
    try {
      db.prepare("VACUUM INTO ?").run(tmp);
    } finally {
      db.close();
    }
    return readFileSync(tmp);
  } finally {
    rmSync(dirname(tmp), { recursive: true, force: true });
  }
}

/** Files of a tree as zip entries (relative to `root`, prefixed with `prefix`). */
function tree(root: string, prefix: string, skip: (rel: string) => boolean, entries: ZipEntry[], snapshotSqlite = false) {
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(root, p);
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        if (/-(wal|shm|journal)$/.test(e.name)) continue;
        entries.push({ path: `${prefix}${rel}`, data: snapshotSqlite && e.name.endsWith(".sqlite") ? snapshotDb(p) : readFileSync(p) });
      }
    }
  };
  if (existsSync(root)) walk(root);
}

/**
 * Snapshot the platform home into dir/hewn-backup-<today>.zip (replacing today's).
 * The workerd host (hewn serve): its Durable Object storage (consistent SQLite snapshots) and blobs.
 * The Node host: platform.db, each capability's state, blobs. Never the secrets key.
 */
export function backupNow(home: Home, dir: string, now = new Date()): BackupInfo {
  const entries: ZipEntry[] = [];
  const workerd = join(home.root, "workerd");
  const kind = existsSync(join(workerd, "do")) ? "workerd" : "node";
  const capabilityIds: string[] = [];
  if (kind === "workerd") {
    // Generated files (worker.js, config, the sandbox profile) are rebuilt at start.
    tree(join(workerd, "do"), "workerd/do/", () => false, entries, true);
    tree(join(workerd, "blobs"), "workerd/blobs/", () => false, entries);
  } else {
    if (existsSync(join(home.root, "platform.json"))) entries.push({ path: "platform.json", data: readFileSync(join(home.root, "platform.json")) });
    if (existsSync(home.db)) entries.push({ path: "platform.db", data: snapshotDb(home.db) });
    for (const id of existsSync(home.capabilities) ? readdirSync(home.capabilities) : []) {
      const src = join(home.capabilities, id);
      if (!statSync(src).isDirectory()) continue;
      capabilityIds.push(id);
      // state.db is snapshotted consistently; per-promotion backups and scratch states are not needed.
      tree(src, `capabilities/${id}/`, (rel) => rel === "backups" || rel === "scratch" || /^state\.db/.test(rel), entries);
      if (existsSync(join(src, "state.db"))) entries.push({ path: `capabilities/${id}/state.db`, data: snapshotDb(join(src, "state.db")) });
    }
    // Versions, owner icons and screenshots are blobs (content-addressed versions are the code itself).
    tree(join(home.root, "blobs"), "blobs/", () => false, entries);
  }
  entries.push({ path: "backup.json", data: Buffer.from(JSON.stringify({ format: FORMAT, kind, createdAt: now.toISOString(), capabilities: capabilityIds }, null, 2) + "\n") });

  mkdirSync(dir, { recursive: true });
  const name = `hewn-backup-${localDate(now)}.zip`;
  // Write next to the target, then rename: a synced folder never sees half a file.
  const partial = join(dir, `.${name}.partial`);
  writeFileSync(partial, createZip(entries, now));
  renameSync(partial, join(dir, name));
  prune(dir);
  const st = statSync(join(dir, name));
  return { file: join(dir, name), name, date: localDate(now), bytes: st.size, at: st.mtime.toISOString() };
}

/** Whether today's backup exists (the daemon makes one per day). */
export const backedUpToday = (dir: string, now = new Date()) => listBackups(dir).some((b) => b.date === localDate(now));

/**
 * Replace the platform home with a backup. The current home is moved aside (never deleted);
 * agent tokens are carried over. Stop Hewn first.
 */
export function restoreBackup(home: Home, file: string): { aside: string; capabilities: string[]; kind: "workerd" | "node" } {
  if (!existsSync(file)) throw new Error(`no backup at ${file}`);
  const entries = readZip(readFileSync(file));
  const meta = JSON.parse(Buffer.from(entries.find((e) => e.path === "backup.json")?.data ?? "{}").toString("utf8"));
  if (meta.format !== FORMAT) throw new Error(`unknown backup format ${meta.format}`);
  const kind: "workerd" | "node" = meta.kind === "workerd" ? "workerd" : "node";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const write = (root: string, strip: string) => {
    for (const e of entries) {
      if (e.path === "backup.json" || !e.path.startsWith(strip)) continue;
      const target = join(root, e.path.slice(strip.length));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, e.data);
    }
  };
  if (kind === "workerd") {
    // Only the data (do/, blobs/) is replaced; generated files, the secrets key and the rest of the home stay.
    const data = join(home.root, "workerd");
    const aside = join(home.root, `workerd-before-restore-${stamp}`);
    mkdirSync(aside, { recursive: true });
    for (const d of ["do", "blobs"]) if (existsSync(join(data, d))) renameSync(join(data, d), join(aside, d));
    write(data, "workerd/");
    for (const d of ["do", "blobs"]) mkdirSync(join(data, d), { recursive: true });
    return { aside, capabilities: [], kind };
  }
  const aside = `${home.root}.before-restore-${stamp}`;
  renameSync(home.root, aside);
  mkdirSync(home.root, { recursive: true });
  write(home.root, "");
  mkdirSync(home.builds, { recursive: true });
  return { aside, capabilities: meta.capabilities ?? [], kind };
}

/** Resolve "2026-10-05", a file name, or a path to a backup file. */
export function findBackup(dir: string, ref: string): string {
  if (existsSync(ref)) return ref;
  const hit = listBackups(dir).find((b) => b.date === ref || b.name === ref || b.name === basename(ref));
  if (!hit) throw new Error(`no backup '${ref}' in ${dir}`);
  return hit.file;
}
