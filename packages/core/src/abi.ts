// SPDX-License-Identifier: AGPL-3.0-or-later
// Capability ABI v2: what a capability's handlers receive, identical on every runtime.
//   export const operations = { "name@N"(input, ctx) { … } }
//   ctx.db      synchronous SQLite (exec, prepare().run/all/get, transaction(fn))
//   ctx.secrets granted secret values; ctx.updateSecret(name, value) to store a refreshed one
//   ctx.config  the owner's values for declared config (ABI 2.1): non-secret settings like a site URL
//   ctx.call(capabilityId, "op@N", input) → Promise of the callee's output (granted ops only)
//   ctx.caller  { kind, id } of whoever made this call (informational)
//   ctx.model.generate({ system?, prompt | messages, schema?, maxTokens? }) (ABI 2.2, with requires.model)
//               → Promise of { text, json?, usage, cost, model }
import type { Migration } from "./migrations.ts";
import type { GenerateRequest, GenerateResult } from "@hewntools/spec/model.ts";

// The ctx types are the spec's (Apache-2.0); this file is the host's side of them.
import type { Ctx as AbiContext, Db as AbiDb, Operations, Statement as AbiStatement } from "@hewntools/spec/ctx.ts";
export type { AbiContext, AbiDb, AbiStatement, Operations };

/** Run one operation of a loaded module. Returns its output and any secret updates it asked for. */
export async function runOperation(
  mod: { operations?: Operations },
  key: string,
  input: unknown,
  env: {
    db: AbiDb;
    secrets?: Record<string, string>;
    config?: Record<string, string>;
    caller?: { kind: string; id: string };
    call: (capabilityId: string, operation: string, input: unknown) => Promise<unknown>;
    /** Present only when the platform grants this call a model (the ABI gate is the platform's). */
    model?: (req: GenerateRequest) => Promise<GenerateResult>;
    /** A widget's call: the state may only be read (writes throw), and secret updates are dropped. */
    readOnly?: boolean;
  },
): Promise<{ output: unknown; secretUpdates: Record<string, string>; inserted: string[] }> {
  const fn = mod.operations?.[key];
  if (typeof fn !== "function") throw new Error(`operation ${key} is not exported`);
  const secretUpdates: Record<string, string> = {};
  const updateSecret = (name: string, value: string) => void (env.readOnly || (secretUpdates[name] = value));
  const inserted = new Set<string>();
  const ctx: AbiContext = {
    // Only validation's calls (tests, sample data) note what they insert: the delete check reads it; live calls skip it.
    db: env.readOnly ? readOnlyDb(env.db) : env.caller?.kind === "test" ? insertsInto(env.db, inserted) : env.db,
    secrets: { ...(env.secrets ?? {}) },
    config: { ...(env.config ?? {}) },
    updateSecret,
    update_secret: updateSecret,
    call: (capabilityId, operation, callInput) => env.call(capabilityId, operation, callInput ?? {}),
    caller: env.caller,
  };
  const model = env.model;
  if (model) ctx.model = { generate: (req) => model(req) };
  const output = await fn(input, ctx);
  // Outputs cross a process/isolate boundary as JSON.
  return { output: output === undefined ? null : JSON.parse(JSON.stringify(output)), secretUpdates, inserted: [...inserted] };
}

/**
 * The tables a statement inserts into (INSERT, INSERT OR …, REPLACE INTO, also after WITH), lowercased:
 * validation's delete check tells a replace (fewer rows, but new ones added) from a delete.
 */
export function insertTargets(sql: string): string[] {
  const s = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");
  // A table name, bare or quoted ("…", `…`, […]); optionally after a schema ("main.").
  const name = '(?:"((?:[^"]|"")+)"|\\x60([^\\x60]+)\\x60|\\[([^\\]]+)\\]|([\\p{L}\\p{N}_$]+))';
  const re = new RegExp(`\\b(?:insert(?:\\s+or\\s+\\w+)?|replace)\\s+into\\s+${name}(?:\\s*\\.\\s*${name})?`, "giu");
  return [...s.matchAll(re)].map((m) => (m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/""/g, '"').toLowerCase());
}

/**
 * The db an operation gets in validation, noting each table a statement that ran inserted into: for run(), only when
 * it changed a row (an INSERT OR IGNORE or DO NOTHING that added none isn't a replace).
 */
function insertsInto(db: AbiDb, into: Set<string>): AbiDb {
  const note = (sql: string) => insertTargets(sql).forEach((t) => into.add(t));
  return {
    exec: (sql) => (db.exec(sql), note(sql)),
    prepare: (sql) => {
      const st = db.prepare(sql);
      const ran = <T>(r: T) => (note(sql), r);
      return {
        run: (...p) => {
          const r = st.run(...p);
          if (Number(r.changes) > 0) note(sql);
          return r;
        },
        all: (...p) => ran(st.all(...p)),
        get: (...p) => ran(st.get(...p)),
      };
    },
    transaction: (fn) => db.transaction(fn),
  };
}

// Words that only appear in statements that change something (once literals are removed).
const WRITES = /\b(insert|update|delete|upsert|create|drop|alter|attach|detach|vacuum|reindex|analyze|savepoint|release|begin|commit|rollback)\b|\breplace\s+into\b/i;

/**
 * Whether a statement only reads. Comments, literals and quoted identifiers are removed first;
 * then it must start with SELECT, WITH, VALUES or EXPLAIN (or be a schema PRAGMA query) and
 * contain no writing keyword anywhere (so "WITH … INSERT" and "… RETURNING" writes are refused).
 */
export function isReadOnlySql(sql: string): boolean {
  const s = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, '""')
    .replace(/\[[^\]]*\]/g, '""')
    .trim();
  if (WRITES.test(s)) return false;
  if (/^pragma\b/i.test(s)) return !s.includes("=") && /^pragma\s+(table_info|table_xinfo|table_list|index_list|index_info|index_xinfo|foreign_key_list|user_version|schema_version)\b/i.test(s);
  return /^(select|with|values|explain)\b/i.test(s);
}

/** The db a widget's operation gets: statements that would write are refused before they run. */
export function readOnlyDb(db: AbiDb): AbiDb {
  const refuse = (sql: string) => new Error(`widgets are read-only: refused ${sql.trim().split(/\s+/).slice(0, 3).join(" ")}…`);
  return {
    exec: (sql) => {
      if (!isReadOnlySql(sql)) throw refuse(sql);
      db.exec(sql);
    },
    prepare: (sql) => {
      if (!isReadOnlySql(sql)) throw refuse(sql);
      return db.prepare(sql);
    },
    transaction: (fn) => db.transaction(fn),
  };
}

export const exportedOperations =(mod: { operations?: Operations }) => Object.keys(mod.operations ?? {}).filter((k) => typeof mod.operations![k] === "function");

/** Apply not-yet-applied migrations, each atomically. Returns the names applied. */
export function applyMigrations(db: AbiDb, migrations: Migration[]): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _hewn_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM _hewn_migrations").all().map((r) => r.name as string));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    try {
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare("INSERT INTO _hewn_migrations (name, applied_at) VALUES (?, ?)").run(m.name, new Date().toISOString());
      });
    } catch (e) {
      throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
    }
    applied.push(m.name);
  }
  return applied;
}

/** Insert exported rows into existing, empty tables (the inverse of dumpTables). Returns rows inserted. */
export function loadTables(db: AbiDb, tables: Record<string, Record<string, unknown>[]>): number {
  const existing = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name as string));
  const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
  let n = 0;
  db.transaction(() => {
    for (const [table, rows] of Object.entries(tables)) {
      if (!existing.has(table) || table.startsWith("_") || table.startsWith("sqlite_")) throw new Error(`no table ${table} (run the migrations first)`);
      if (Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q(table)}`).get()!.n) > 0) throw new Error(`table ${table} already has rows`);
      for (const row of rows) {
        const cols = Object.keys(row);
        const values = cols.map((c) => {
          const v = row[c] as unknown;
          return v && typeof v === "object" && "base64" in (v as object) ? Uint8Array.from(atob((v as { base64: string }).base64), (ch) => ch.charCodeAt(0)) : v;
        });
        db.prepare(`INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...values);
        n++;
      }
    }
  });
  return n;
}

/** The no-loss check's snapshots of a copy's keys (markKeys, keysSince), kept in the copy itself. */
const KEYS_META = "_hewn_keys_meta";
const KEYS_BEFORE = "_hewn_keys_before";
const KEYS_NOW = "_hewn_keys_now";
const SNAPSHOTS = new Set([KEYS_META, KEYS_BEFORE, KEYS_NOW]);
/** A state's own tables (not SQLite's, the host's, the migrations record or the no-loss check's snapshots), by name. */
const userTables = (db: AbiDb) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != '_hewn_migrations' ORDER BY name")
    .all()
    .map((r) => String(r.name))
    .filter((n) => !SNAPSHOTS.has(n));
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Every user table as JSON rows (BLOBs as base64). */
export function dumpTables(db: AbiDb): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const name of userTables(db)) {
    out[name] = db.prepare(`SELECT * FROM ${quoted(name)}`).all().map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array || v instanceof ArrayBuffer ? { base64: b64(new Uint8Array(v as ArrayBuffer)) } : v])),
    );
  }
  return out;
}

/** The tables SQLite's own virtual tables keep beside them (FTS3/4/5, R*Tree): their names end so. */
const SHADOW = ["_data", "_idx", "_content", "_docsize", "_config", "_segments", "_segdir", "_stat", "_node", "_parent", "_rowid"];
/** One key column as text, the same whatever number type holds it (1, 1.0 and '1' alike, so a type change keeps it); NULL its own. */
const keyText = (column: string) => {
  const c = quoted(column);
  return `CASE WHEN ${c} IS NULL THEN char(0) WHEN typeof(${c}) = 'real' AND ${c} = CAST(${c} AS INTEGER) THEN CAST(CAST(${c} AS INTEGER) AS TEXT) ELSE CAST(${c} AS TEXT) END`;
};

/**
 * The tables whose rows the no-loss check counts: each with its primary key's columns (`cols`) and that key as text
 * (`key`; none where the table has no primary key: its rowids may be renumbered, so only its rows are counted), and
 * its root page (`root`: a rename keeps it). Not a virtual table nor its shadow tables (an FTS index rewrites them).
 */
function keyedTables(db: AbiDb): { name: string; cols: string; key: string | null; root: number | null }[] {
  const virtual = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")
    .all()
    .map((r) => String(r.name));
  const roots = new Map(
    db
      .prepare("SELECT name, rootpage FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => [String(r.name), Number(r.rootpage) || null]),
  );
  return userTables(db)
    .filter((name) => !virtual.some((v) => name === v || SHADOW.some((s) => name === `${v}${s}`)))
    .map((name) => {
      const pk = db
        .prepare(`PRAGMA table_info(${quoted(name)})`)
        .all()
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => String(c.name));
      return { name, cols: pk.join(","), key: pk.length ? pk.map(keyText).join(" || char(31) || ") : null, root: roots.get(name) ?? null };
    });
}

/** Drop the no-loss check's snapshots. */
function dropSnapshots(db: AbiDb) {
  for (const t of SNAPSHOTS) db.exec(`DROP TABLE IF EXISTS ${quoted(t)}`);
}

/** Every keyed table's rows and keys, written into the state itself as `snap` (KEYS_BEFORE or KEYS_NOW). */
function snapshotKeys(db: AbiDb, snap: string) {
  const [M, S] = [quoted(KEYS_META), quoted(snap)];
  db.exec(`CREATE TABLE IF NOT EXISTS ${M} (snap TEXT NOT NULL, t INTEGER NOT NULL, tbl TEXT NOT NULL, cols TEXT NOT NULL, root INTEGER, n INTEGER NOT NULL, PRIMARY KEY (snap, t))`);
  db.prepare(`DELETE FROM ${M} WHERE snap = ?`).run(snap);
  db.exec(`DROP TABLE IF EXISTS ${S}`);
  db.exec(`CREATE TABLE ${S} (t INTEGER NOT NULL, k TEXT NOT NULL)`);
  keyedTables(db).forEach((x, t) => {
    const n = Number(db.prepare(`SELECT count(*) AS n FROM ${quoted(x.name)}`).get()?.n ?? 0);
    db.prepare(`INSERT INTO ${M} (snap, t, tbl, cols, root, n) VALUES (?, ?, ?, ?, ?, ?)`).run(snap, t, x.name, x.cols, x.root, n);
    if (x.key && n) db.prepare(`INSERT INTO ${S} (t, k) SELECT ?, ${x.key} FROM ${quoted(x.name)}`).run(t);
  });
  db.exec(`CREATE INDEX ${quoted(`${snap}_k`)} ON ${S} (t, k)`);
}

/**
 * The no-loss check's first measurement, on a copy: every keyed table's rows and keys, kept in the copy itself (no key
 * ever leaves the state, however many rows), for `keysSince` after the migrations. A failure (no room left) leaves no
 * snapshot behind.
 */
export function markKeys(db: AbiDb): void {
  try {
    snapshotKeys(db, KEYS_BEFORE);
  } catch (e) {
    dropSnapshots(db);
    throw e;
  }
}

/**
 * What became of the rows `markKeys` saw, per table that had some: how many it had (`before`), has now (`after`), and
 * how many of its keys are still there (`kept`, each key as often as before; null where it has no primary key, or its
 * key columns changed, so only the counts compare). A table renamed (its root page under another name) is followed
 * (`renamed`). One that's gone (`gone`) is looked for in the new tables with the same key columns (a merge, a split);
 * `after` is then their rows. `added`: the rows of tables it didn't see; `rows`: all rows, before and now. Counts only;
 * the snapshots are dropped.
 */
export interface KeysSince {
  tables: Record<string, { before: number; after: number | null; kept: number | null; gone?: true; renamed?: string }>;
  added: Record<string, number>;
  rows: { before: number; now: number };
}
export function keysSince(db: AbiDb): KeysSince {
  try {
    snapshotKeys(db, KEYS_NOW);
    type Meta = { t: number; tbl: string; cols: string; root: number | null; n: number };
    const meta = (snap: string): Meta[] =>
      db
        .prepare(`SELECT t, tbl, cols, root, n FROM ${quoted(KEYS_META)} WHERE snap = ? ORDER BY t`)
        .all(snap)
        .map((r) => ({ t: Number(r.t), tbl: String(r.tbl), cols: String(r.cols), root: r.root === null ? null : Number(r.root), n: Number(r.n) }));
    const [before, now] = [meta(KEYS_BEFORE), meta(KEYS_NOW)];
    const [B, N] = [quoted(KEYS_BEFORE), quoted(KEYS_NOW)];
    // Each key of `t` before, counted as many times as it's still there in `into` now (at most as often as before).
    const kept = (t: number, into: number[]) =>
      Number(
        db
          .prepare(`SELECT coalesce(sum(min(b.n, coalesce(a.n, 0))), 0) AS n FROM (SELECT k, count(*) AS n FROM ${B} WHERE t = ? GROUP BY k) b LEFT JOIN (SELECT k, count(*) AS n FROM ${N} WHERE t IN (${into.map(() => "?").join(", ")}) GROUP BY k) a ON a.k = b.k`)
          .get(t, ...into)?.n ?? 0,
      );
    const had = new Set(before.map((x) => x.tbl));
    const byName = new Map(now.map((x) => [x.tbl, x]));
    const byRoot = new Map(now.filter((x) => x.root !== null && !had.has(x.tbl)).map((x) => [x.root, x]));
    const out: KeysSince = { tables: {}, added: {}, rows: { before: before.reduce((n, x) => n + x.n, 0), now: now.reduce((n, x) => n + x.n, 0) } };
    const followed = new Set<string>();
    const gone: Meta[] = [];
    for (const b of before) {
      const there = byName.get(b.tbl) ?? (b.root !== null ? byRoot.get(b.root) : undefined);
      if (!there) {
        gone.push(b);
        continue;
      }
      followed.add(there.tbl);
      if (!b.n) continue;
      out.tables[b.tbl] = { before: b.n, after: there.n, kept: b.cols && b.cols === there.cols ? kept(b.t, [there.t]) : null, ...(there.tbl !== b.tbl ? { renamed: there.tbl } : {}) };
    }
    const fresh = now.filter((x) => !had.has(x.tbl) && !followed.has(x.tbl));
    for (const b of gone) {
      if (!b.n) continue;
      const into = fresh.filter((x) => b.cols && x.cols === b.cols);
      out.tables[b.tbl] = { before: b.n, after: into.length ? into.reduce((n, x) => n + x.n, 0) : null, kept: into.length ? kept(b.t, into.map((x) => x.t)) : null, gone: true };
    }
    for (const x of fresh) out.added[x.tbl] = x.n;
    return out;
  } finally {
    dropSnapshots(db);
  }
}

/** `keysSince`'s answer from rows counted per table (countTables, before and after), where no keys could be kept. */
export function countsSince(before: Record<string, number>, after: Record<string, number>): KeysSince {
  const tables: KeysSince["tables"] = {};
  for (const [t, n] of Object.entries(before)) if (n) tables[t] = t in after ? { before: n, after: after[t], kept: null } : { before: n, after: null, kept: null, gone: true };
  const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
  return { tables, added: Object.fromEntries(Object.entries(after).filter(([t]) => !(t in before))), rows: { before: sum(before), now: sum(after) } };
}

/** Rows `keysSince` saw, before and now. */
export const rowsSince = (k: KeysSince) => k.rows;

/**
 * The no-loss invariant's rules on what `keysSince` saw: a table keeps every key it had, as often as it had it (a
 * renamed one under its new name; a gone one in new tables with the same key columns), and where only its rows can be
 * counted, keeps its count; and the rows across all tables never drop (a gone table's rows must reappear elsewhere).
 * In words, names and counts only. It catches a migration's mistakes, not an adversary: an UPDATE that blanks every
 * row's content keeps every key.
 */
export function lostRows(k: KeysSince): string[] {
  const problems: string[] = [];
  for (const [table, t] of Object.entries(k.tables)) {
    if (!t.before) continue;
    if (t.kept !== null && t.kept < t.before) problems.push(`\`${table}\` would lose ${t.before - t.kept} of its ${t.before} rows${t.after !== null && t.after >= t.before ? " (their keys change)" : ""}`);
    else if (t.kept === null && !t.gone && t.after !== null && t.after < t.before) problems.push(`\`${table}\` would lose ${t.before - t.after} of its ${t.before} rows`);
  }
  const { before, now } = k.rows;
  if (now < before) problems.push(`${before - now} fewer rows across its tables (${before} before, ${now} after)`);
  return problems;
}

/** Rows per user table (Info › Data): counts only, no rows leave the state. */
export function countTables(db: AbiDb): Record<string, number> {
  return Object.fromEntries(userTables(db).map((name) => [name, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(name)}`).get()?.n ?? 0)]));
}

function b64(b: Uint8Array) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** The console lines of a call Hewn keeps, and the characters of each. */
export const LOG_LINES = 200;
export const LOG_LINE_CHARS = 500;
/** The characters of a failed call's error Hewn keeps and passes on (as many as its failure record keeps). */
export const ERROR_CHARS = 1000;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/**
 * Cap a call's console lines ("| " log, "! " error/warn): at most LOG_LINES, the last one saying how
 * many more there were, each at most LOG_LINE_CHARS. Anything but strings is left out. Capping
 * again changes nothing, so the platform caps what comes back from a tool's isolate once more.
 */
export function capLines(lines: unknown): string[] {
  const all = Array.isArray(lines) ? lines.filter((l): l is string => typeof l === "string") : [];
  if (all.length <= LOG_LINES) return all.map((l) => cut(l, LOG_LINE_CHARS));
  return [...all.slice(0, LOG_LINES - 1).map((l) => cut(l, LOG_LINE_CHARS)), `… ${all.length - LOG_LINES + 1} more lines`];
}

/** A failed call's error, cut to ERROR_CHARS. */
export const capError = (message: string) => cut(message, ERROR_CHARS);

export const CALL_TIMEOUT_MS = 30_000;
