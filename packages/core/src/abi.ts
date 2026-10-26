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
): Promise<{ output: unknown; secretUpdates: Record<string, string> }> {
  const fn = mod.operations?.[key];
  if (typeof fn !== "function") throw new Error(`operation ${key} is not exported`);
  const secretUpdates: Record<string, string> = {};
  const updateSecret = (name: string, value: string) => void (env.readOnly || (secretUpdates[name] = value));
  const ctx: AbiContext = {
    db: env.readOnly ? readOnlyDb(env.db) : env.db,
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
  return { output: output === undefined ? null : JSON.parse(JSON.stringify(output)), secretUpdates };
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

/** Every user table as JSON rows (BLOBs as base64). */
/** A state's own tables (not SQLite's, the host's or the migrations record), by name. */
const userTables = (db: AbiDb) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != '_hewn_migrations' ORDER BY name").all().map((r) => String(r.name));
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function dumpTables(db: AbiDb): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const name of userTables(db)) {
    out[name] = db.prepare(`SELECT * FROM ${quoted(name)}`).all().map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array || v instanceof ArrayBuffer ? { base64: b64(new Uint8Array(v as ArrayBuffer)) } : v])),
    );
  }
  return out;
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

/** Cap and prefix a call's console lines ("| " log, "! " error/warn). */
export function capLines(lines: string[]): string[] {
  const out = lines.slice(0, 200).map((l) => (l.length > 500 ? l.slice(0, 500) + "…" : l));
  if (lines.length > 200) out.push(`… ${lines.length - 200} more lines`);
  return out;
}

export const CALL_TIMEOUT_MS = 30_000;
