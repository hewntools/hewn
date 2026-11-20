// SPDX-License-Identifier: AGPL-3.0-or-later
// Capability state schema rules: append-only, non-destructive migrations shipped with each version.
import { text } from "./files.ts";
import type { Files } from "./ports.ts";

export interface Migration {
  name: string;
  sql: string;
}

const MIGRATION_NAME = /^\d{3}_[a-z0-9_]+\.sql$/;
const DESTRUCTIVE = /\b(drop\s+table|drop\s+column|delete\s+from|truncate)\b/i;

/** The migrations/ directory of an implementation, in order. */
export function migrationsOf(files: Files): Migration[] {
  return Object.keys(files)
    .filter((p) => p.startsWith("migrations/") && p.endsWith(".sql") && !p.slice("migrations/".length).includes("/"))
    .sort()
    .map((p) => ({ name: p.slice("migrations/".length), sql: text(files[p]) }));
}

export function migrationProblems(migrations: Migration[], base: Migration[]): string[] {
  const out: string[] = [];
  for (const m of migrations) {
    if (!MIGRATION_NAME.test(m.name)) out.push(`migration ${m.name}: name must match NNN_snake_case.sql`);
    if (DESTRUCTIVE.test(m.sql)) out.push(`migration ${m.name}: destructive statements are not allowed`);
    // Durable Object SQL manages transactions itself (each migration is applied atomically).
    if (/^\s*(begin|commit|rollback|savepoint|release)\b/im.test(m.sql)) out.push(`migration ${m.name}: transaction statements (BEGIN/COMMIT) are not allowed; each migration already runs atomically`);
    // A shipped one ran already; it can't be edited, so it isn't held to a rule added after it.
    const end = endProblem(m.sql);
    if (end && !base.some((b) => b.name === m.name && b.sql === m.sql)) out.push(`migration ${m.name}: ${end}`);
  }
  for (const b of base) {
    const cur = migrations.find((m) => m.name === b.name);
    if (!cur) out.push(`migration ${b.name}: removed (migrations are append-only)`);
    else if (cur.sql !== b.sql) out.push(`migration ${b.name}: modified (migrations are append-only)`);
  }
  return out;
}

/**
 * What's wrong with how the file ends, if anything: it must end with its last statement's `;`, followed only
 * by whitespace. Durable Object SQL refuses a comment or a second `;` after it ("SQL code did not contain a
 * statement"); node:sqlite doesn't. Comments and quoted text elsewhere are skipped, so a `;` inside them
 * doesn't count.
 */
function endProblem(sql: string): string | undefined {
  let last = -1;
  let code = false; // code since the previous `;`
  let lastHadCode = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = sql.indexOf(c === "[" ? "]" : c, i + 1);
      i = end < 0 ? sql.length : end;
      code = true;
    } else if (c === ";") {
      last = i;
      lastHadCode = code;
      code = false;
    } else if (!/\s/.test(c)) code = true;
  }
  if (last < 0 || code) return "end it with `;`";
  // SQLite's whitespace only: a no-break space or a BOM is not.
  if (!lastHadCode || !/^[ \t\r\n\f]*$/.test(sql.slice(last + 1))) return "nothing may follow the last statement; end it with `;`";
  return undefined;
}

/**
 * Why older code might not run on state migrated for a newer version: statements that make
 * rows written by old code invalid. Migrations are additive, so this is a short list.
 */
export function rollbackProblems(later: Migration[]): string[] {
  const out: string[] = [];
  for (const m of later) {
    for (const stmt of m.sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      if (/\balter\s+table\b[\s\S]*\badd\s+(column\s+)?[\s\S]*\bnot\s+null\b/i.test(stmt) && !/\bdefault\b/i.test(stmt)) {
        out.push(`${m.name}: adds a NOT NULL column without a default (older code can't insert rows)`);
      } else if (/\brename\b/i.test(stmt)) out.push(`${m.name}: renames a table or column (older code would look for the old name)`);
      else if (/\bcreate\s+unique\s+index\b/i.test(stmt)) out.push(`${m.name}: adds a unique index (older code may write duplicates)`);
    }
  }
  return out;
}
