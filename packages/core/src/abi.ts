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
const KEYS_BEFORE = "_hewn_keys_before";
const KEYS_NOW = "_hewn_keys_now";
/** A state's own tables (not SQLite's, the host's, the migrations record or the no-loss check's snapshots), by name. */
const userTables = (db: AbiDb) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != '_hewn_migrations' ORDER BY name")
    .all()
    .map((r) => String(r.name))
    .filter((n) => n !== KEYS_BEFORE && n !== KEYS_NOW);
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

/**
 * The tables whose rows the no-loss check counts, each with its key: its primary key's columns (`cols`; "" for none,
 * where the rowid is the key), as text, so a column whose type changes keeps its keys. Not a virtual table nor its
 * shadow tables (an FTS index rewrites those as it likes).
 */
function keyedTables(db: AbiDb): { name: string; cols: string; key: string }[] {
  const virtual = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")
    .all()
    .map((r) => String(r.name));
  return userTables(db)
    .filter((name) => !virtual.some((v) => name === v || name.startsWith(`${v}_`)))
    .map((name) => {
      const pk = db
        .prepare(`PRAGMA table_info(${quoted(name)})`)
        .all()
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => String(c.name));
      const key = pk.length ? pk.map((c) => `coalesce(CAST(${quoted(c)} AS TEXT), '')`).join(" || char(31) || ") : "CAST(rowid AS TEXT)";
      return { name, cols: pk.join(","), key };
    });
}

/** Every keyed table's keys, written into `into` in the state itself. */
function snapshotKeys(db: AbiDb, into: string) {
  db.exec(`DROP TABLE IF EXISTS ${quoted(into)}`);
  db.exec(`CREATE TABLE ${quoted(into)} (tbl TEXT NOT NULL, cols TEXT NOT NULL, k TEXT NOT NULL)`);
  for (const t of keyedTables(db)) db.prepare(`INSERT INTO ${quoted(into)} (tbl, cols, k) SELECT ?, ?, ${t.key} FROM ${quoted(t.name)}`).run(t.name, t.cols);
  db.exec(`CREATE INDEX ${quoted(`${into}_k`)} ON ${quoted(into)} (tbl, k)`);
}

/**
 * The no-loss check's first measurement, on a copy: every keyed table's keys, kept in the copy itself (no key ever
 * leaves the state, however many rows), for `keysSince` after the migrations.
 */
export function markKeys(db: AbiDb): void {
  snapshotKeys(db, KEYS_BEFORE);
}

/**
 * What became of the rows `markKeys` saw, per table that had some: how many it had (`before`), has now (`after`), and
 * how many of its keys are still there (`kept`; null when its key columns changed, so only the counts compare). A
 * table that's gone (`gone`) is looked for in the new tables with the same key columns (a rename, a merge, a split);
 * `after` is then their rows. `added`: the rows of tables it didn't see. Counts only; the snapshots are dropped.
 */
export interface KeysSince {
  tables: Record<string, { before: number; after: number | null; kept: number | null; gone?: true }>;
  added: Record<string, number>;
}
export function keysSince(db: AbiDb): KeysSince {
  snapshotKeys(db, KEYS_NOW);
  const counts = (table: string) => db.prepare(`SELECT tbl, cols, count(*) AS n FROM ${quoted(table)} GROUP BY tbl, cols`).all() as { tbl: string; cols: string; n: number }[];
  const one = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).get(...params)?.n ?? 0);
  const before = counts(KEYS_BEFORE);
  const now = new Map(counts(KEYS_NOW).map((r) => [r.tbl, Number(r.n)]));
  const exists = new Map(keyedTables(db).map((t) => [t.name, t.cols]));
  const seen = new Set(before.map((r) => r.tbl));
  const out: KeysSince = { tables: {}, added: {} };
  const [B, N] = [quoted(KEYS_BEFORE), quoted(KEYS_NOW)];
  for (const b of before) {
    const cols = exists.get(b.tbl);
    if (cols !== undefined) {
      const kept = cols === b.cols ? one(`SELECT count(*) AS n FROM ${B} b JOIN ${N} a ON a.tbl = b.tbl AND a.k = b.k WHERE b.tbl = ?`, b.tbl) : null;
      out.tables[b.tbl] = { before: Number(b.n), after: now.get(b.tbl) ?? 0, kept };
      continue;
    }
    const into = [...exists].filter(([name, c]) => !seen.has(name) && c === b.cols && c !== "").map(([name]) => name);
    const kept = into.length ? one(`SELECT count(*) AS n FROM ${B} b WHERE b.tbl = ? AND EXISTS (SELECT 1 FROM ${N} a WHERE a.tbl IN (${into.map(() => "?").join(", ")}) AND a.k = b.k)`, b.tbl, ...into) : null;
    out.tables[b.tbl] = { before: Number(b.n), after: into.length ? into.reduce((n, t) => n + (now.get(t) ?? 0), 0) : null, kept, gone: true };
  }
  for (const name of exists.keys()) if (!seen.has(name)) out.added[name] = now.get(name) ?? 0;
  db.exec(`DROP TABLE IF EXISTS ${B}`);
  db.exec(`DROP TABLE IF EXISTS ${N}`);
  return out;
}

/** Rows `keysSince` saw, before and now (a gone table's rows counted where they went, once). */
export function rowsSince(k: KeysSince): { before: number; now: number } {
  const tables = Object.values(k.tables);
  return {
    before: tables.reduce((n, t) => n + t.before, 0),
    now: tables.reduce((n, t) => n + (t.gone ? 0 : (t.after ?? 0)), 0) + Object.values(k.added).reduce((n, c) => n + c, 0),
  };
}

/**
 * The no-loss invariant's rules on what `keysSince` saw: a table keeps every key it had, or, gone, has them in a new
 * table with the same key columns (a lost or renumbered one is lost; where its key columns changed, its count must
 * hold); and the rows across all tables never drop (a gone table's rows must reappear elsewhere: a rename, a merge or
 * a split passes). In words, names and counts only.
 */
export function lostRows(k: KeysSince): string[] {
  const problems: string[] = [];
  for (const [table, t] of Object.entries(k.tables)) {
    if (!t.before) continue;
    if (t.kept !== null && t.kept < t.before) problems.push(`\`${table}\` would lose ${t.before - t.kept} of its ${t.before} rows${t.after !== null && t.after >= t.before ? " (their keys change)" : ""}`);
    else if (t.kept === null && !t.gone && t.after !== null && t.after < t.before) problems.push(`\`${table}\` would lose ${t.before - t.after} of its ${t.before} rows`);
  }
  const { before, now } = rowsSince(k);
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
