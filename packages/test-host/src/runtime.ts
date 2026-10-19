// SPDX-License-Identifier: AGPL-3.0-or-later
// In-process ABI v2 runtime for the Node host (tests and development). No isolation:
// capability code runs in this process. The workerd host is the runtime that isolates.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { format } from "node:util";
import { pathToFileURL } from "node:url";
import { type AbiDb, applyMigrations, CALL_TIMEOUT_MS, capLines, dumpTables, exportedOperations, loadTables, runOperation } from "@hewntools/core/abi.ts";
import { deadlineOf, deadlineTimer } from "@hewntools/core/deadline.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import type { CapabilityRuntime, CodeRef, StateRef } from "@hewntools/core/ports.ts";

/** node:sqlite through the ABI v2 db facade. */
export function abiDb(db: DatabaseSync): AbiDb {
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const st = db.prepare(sql);
      return {
        run: (...p) => {
          const r = st.run(...(p as any[]));
          return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
        },
        all: (...p) => st.all(...(p as any[])) as Record<string, any>[],
        get: (...p) => st.get(...(p as any[])) as Record<string, any> | undefined,
      };
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      db.exec("BEGIN");
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
  };
}

// Route console output of a call to that call's log (concurrent calls stay apart).
const logs = new AsyncLocalStorage<string[]>();
let consolePatched = false;
function patchConsole() {
  if (consolePatched) return;
  consolePatched = true;
  for (const [method, prefix] of [["log", "| "], ["info", "| "], ["debug", "| "], ["warn", "! "], ["error", "! "]] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const sink = logs.getStore();
      if (sink) for (const line of format(...args).split("\n")) sink.push(prefix + line);
      else original(...args);
    };
  }
}

/** State files: live state.db, backups/<name>.db, scratch/<name>.db (per capability). */
export function statePathOf(capabilitiesDir: string, s: StateRef): string {
  const dir = join(capabilitiesDir, s.capabilityId);
  if (!s.scratch) return join(dir, "state.db");
  const safe = s.scratch.replace(/[^a-zA-Z0-9._-]+/g, "_");
  if (s.scratch.startsWith("backup:")) return join(dir, "backups", `${s.scratch.slice("backup:".length).replace(/[^a-zA-Z0-9._-]+/g, "_")}.db`);
  return join(dir, "scratch", `${safe}.db`);
}

export function inProcessRuntime(home: { root: string; capabilities: string }): CapabilityRuntime {
  const codeDir = join(home.root, "code");
  const modules = new Map<string, Promise<{ operations?: Record<string, any> }>>();
  const load = (code: CodeRef) => {
    let m = modules.get(code.hash);
    if (!m) {
      mkdirSync(codeDir, { recursive: true });
      const file = join(codeDir, `${code.hash}.mjs`);
      writeFileSync(file, code.js);
      m = import(pathToFileURL(file).href);
      modules.set(code.hash, m);
    }
    return m;
  };
  const open = (s: StateRef) => {
    const path = statePathOf(home.capabilities, s);
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    return db;
  };
  const withDb = <T>(s: StateRef, fn: (db: AbiDb) => T): T => {
    const db = open(s);
    try {
      return fn(abiDb(db));
    } finally {
      db.close();
    }
  };

  return {
    async invoke(target, key, input, onCall, onModel) {
      patchConsole();
      const mod = await load(target.code);
      const lines: string[] = [];
      const db = open(target.state);
      const timer = deadlineTimer(deadlineOf(target.deadline, CALL_TIMEOUT_MS), () => new PlatformError("operation_failed", `${key} timed out (call chain deadline)`, { timeout: true }));
      try {
        const run = logs.run(lines, () =>
          runOperation(mod, key, input, {
            db: abiDb(db),
            secrets: target.secrets,
            config: target.config,
            caller: target.caller,
            call: async (capabilityId, operation, callInput) => {
              if (!onCall) throw new Error("capability calls are not available here");
              return onCall({ capabilityId, operation, input: callInput });
            },
            ...(onModel ? { model: onModel } : {}),
            readOnly: target.readOnly,
          }),
        );
        const { output, secretUpdates } = await Promise.race([run, timer.expired]);
        return { output, secretUpdates, logs: capLines(lines) };
      } catch (e) {
        if (e instanceof PlatformError && (e.details as { timeout?: boolean } | undefined)?.timeout) {
          e.details = { logs: capLines(lines) };
          throw e;
        }
        // Anything the capability throws (including a refused nested call) is its failure, as it
        // would be across an isolate boundary.
        throw new PlatformError("operation_failed", `${key} failed: ${(e as Error).message}`, { logs: capLines(lines) });
      } finally {
        timer.clear();
        db.close();
      }
    },
    async describe(code) {
      return exportedOperations(await load(code));
    },
    async migrate(state, migrations) {
      return withDb(state, (db) => applyMigrations(db, migrations));
    },
    async hasState(state) {
      return existsSync(statePathOf(home.capabilities, state));
    },
    async copyState(from, to) {
      const target = statePathOf(home.capabilities, to);
      mkdirSync(join(target, ".."), { recursive: true });
      rmSync(target, { force: true });
      const db = open(from);
      try {
        db.prepare("VACUUM INTO ?").run(target);
      } finally {
        db.close();
      }
    },
    async dropState(state) {
      const p = statePathOf(home.capabilities, state);
      for (const f of [p, `${p}-wal`, `${p}-shm`, `${p}-journal`]) rmSync(f, { force: true });
    },
    async listStates(capabilityId, prefix) {
      const out: string[] = [];
      const dir = join(home.capabilities, capabilityId);
      for (const [sub, kind] of [["backups", "backup:"], ["scratch", ""]] as const) {
        if (!existsSync(join(dir, sub))) continue;
        for (const f of readdirSync(join(dir, sub))) if (f.endsWith(".db")) out.push(kind + f.slice(0, -3));
      }
      return out.filter((n) => n.startsWith(prefix));
    },
    async loadState(state, tables) {
      return withDb(state, (db) => loadTables(db, tables));
    },
    async dumpState(state) {
      if (!existsSync(statePathOf(home.capabilities, state))) return {};
      return withDb(state, (db) => dumpTables(db));
    },
  };
}
