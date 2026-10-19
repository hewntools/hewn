// SPDX-License-Identifier: Apache-2.0
// What a tool's code exports, and the `ctx` each operation receives. Identical on every host.
//
//   import type { Ctx } from "@hewntools/spec/ctx.ts";
//   export const operations = {
//     "record_run@1"(input: { km: number }, { db }: Ctx) { … },
//   };
//
// A type-only import: it disappears when the tool is bundled, so tools have no runtime dependency.
import type { GenerateRequest, GenerateResult } from "./model.ts";

export interface Statement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all(...params: unknown[]): Record<string, any>[];
  get(...params: unknown[]): Record<string, any> | undefined;
}

/** The tool's own SQLite database: synchronous. Schema changes go in migrations/. */
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  /** Runs `fn` in a transaction (SAVEPOINT, BEGIN and COMMIT aren't allowed in tool code). */
  transaction<T>(fn: () => T): T;
}

export interface Ctx {
  db: Db;
  /** The granted secret values, by name (connections only: `requires.secrets`). */
  secrets: Record<string, string>;
  /** The owner's values for the declared `config` (ABI 2.1). */
  config: Record<string, string>;
  /** Stores a refreshed secret (e.g. a rotated token). Dropped when the call is a widget's (read only). */
  updateSecret(name: string, value: string): void;
  /** Older spelling of updateSecret. */
  update_secret(name: string, value: string): void;
  /** Calls another tool's operation ("op@N"), if `requires.capabilities` lists it and the owner granted it. */
  call(capabilityId: string, operation: string, input?: unknown): Promise<unknown>;
  /** Who made this call (informational). */
  caller?: { kind: string; id: string };
  /** A model the host runs for the tool (ABI 2.2, with `requires.model`). */
  model?: { generate(req: GenerateRequest): Promise<GenerateResult> };
}

/** The module a tool exports: `operations`, keyed "name@version". */
export type Operations = Record<string, (input: unknown, ctx: Ctx) => unknown>;

/** Every `ctx` member, with the ABI version that introduced it. */
export const CTX_MEMBERS: { name: keyof Ctx; since: string }[] = [
  { name: "db", since: "2.0" },
  { name: "secrets", since: "2.0" },
  { name: "config", since: "2.1" },
  { name: "updateSecret", since: "2.0" },
  { name: "update_secret", since: "2.0" },
  { name: "call", since: "2.0" },
  { name: "caller", since: "2.0" },
  { name: "model", since: "2.2" },
];
