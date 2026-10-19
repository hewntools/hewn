// SPDX-License-Identifier: AGPL-3.0-or-later
// Main module of every capability's Dynamic Worker (bundled to text by the supervisor and loaded
// next to the capability's own bundle, "capability.js"). It turns the capability's `operations`
// into a Durable Object class that the CapabilityHost runs as a facet: the capability's private
// SQLite lives in that facet's storage. Capability ABI v2 (see src/core/abi.ts).
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
// @ts-expect-error provided at load time: the capability's own bundle
import * as capability from "./capability.js";
import { type AbiDb, applyMigrations, capLines, dumpTables, exportedOperations, loadTables, runOperation } from "@hewntools/core/abi.ts";
import type { Migration } from "@hewntools/core/migrations.ts";

const mod = capability as { operations?: Record<string, any> };

// Route console output of a call to that call's log (concurrent calls stay apart).
const logs = new AsyncLocalStorage<string[]>();
for (const [method, prefix] of [["log", "| "], ["info", "| "], ["debug", "| "], ["warn", "! "], ["error", "! "]] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const sink = logs.getStore();
    const line = args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
    if (sink) for (const l of line.split("\n")) sink.push(prefix + l);
    else original(...args);
  };
}

type SqlStorage = DurableObjectState["storage"]["sql"];

/** The ABI v2 db facade over Durable Object SQL (synchronous). */
function abiDb(sql: SqlStorage, storage: DurableObjectState["storage"]): AbiDb {
  const rows = (query: string, params: unknown[]) => [...sql.exec(query, ...params)] as Record<string, any>[];
  return {
    exec: (query) => void sql.exec(query).toArray(),
    prepare: (query) => ({
      run: (...params) => {
        const cursor = sql.exec(query, ...params);
        cursor.toArray();
        const id = sql.exec("SELECT last_insert_rowid() AS id").one().id as number;
        return { changes: cursor.rowsWritten, lastInsertRowid: id };
      },
      all: (...params) => rows(query, params),
      get: (...params) => rows(query, params)[0],
    }),
    // Nested calls join the outer transaction.
    transaction: (fn) => storage.transactionSync(fn),
  };
}

export class Capability extends DurableObject {
  private db(): AbiDb {
    return abiDb(this.ctx.storage.sql, this.ctx.storage);
  }

  migrate(migrations: Migration[]): string[] {
    return applyMigrations(this.db(), migrations);
  }

  dump() {
    return dumpTables(this.db());
  }

  load(tables: Record<string, Record<string, unknown>[]>): number {
    return loadTables(this.db(), tables);
  }

  /**
   * Run one operation. Errors come back as values (not throws) so the capability's log lines
   * survive the trip back to the platform.
   */
  async invoke(key: string, input: unknown, secrets: Record<string, string>, caller: { kind: string; id: string } | undefined, call: (capabilityId: string, operation: string, input: unknown) => Promise<unknown>, config: Record<string, string> = {}, model: ((req: unknown) => Promise<any>) | null = null, readOnly = false) {
    const lines: string[] = [];
    try {
      const { output, secretUpdates } = await logs.run(lines, () =>
        runOperation(mod, key, input, { db: this.db(), secrets, config, caller, call: (id, op, i) => call(id, op, i), ...(model ? { model: (req) => model(req) } : {}), readOnly }),
      );
      return { ok: true as const, output, secretUpdates, logs: capLines(lines) };
    } catch (e) {
      return { ok: false as const, error: (e as Error)?.message ?? String(e), logs: capLines(lines) };
    }
  }
}

export default class extends WorkerEntrypoint {
  describe(): string[] {
    return exportedOperations(mod);
  }
}
