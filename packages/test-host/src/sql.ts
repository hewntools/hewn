// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Sql } from "@hewntools/core/ports.ts";

/** The core's Sql port over node:sqlite (a file, or ":memory:"). */
export function nodeSql(path: string): Sql {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql) as unknown as ReturnType<Sql["prepare"]>,
    transaction<T>(fn: () => T): T {
      // Nested calls join the outer transaction (as Durable Object transactionSync does).
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}
