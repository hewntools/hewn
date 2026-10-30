// SPDX-License-Identifier: AGPL-3.0-or-later
// What the core needs from a host. Node (tests, dev) and workerd each implement these;
// the core itself never touches a filesystem, a process or a socket.
import type { Agent, Scope } from "./auth.ts";
import type { Deadline } from "./deadline.ts";
import type { Migration } from "./migrations.ts";
import type { ModelHandler } from "./models.ts";
import type { Pass } from "./passes.ts";

/** Implementation files by POSIX path ("src/index.ts", "ui/index.html"). */
export type Files = Record<string, Uint8Array>;

// ---------- SQL (synchronous: node:sqlite or Durable Object storage.sql) ----------

export interface SqlStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Record<string, any>[];
  get(...params: unknown[]): Record<string, any> | undefined;
}

export interface Sql {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<T>(fn: () => T): T;
  close?(): void;
}

// ---------- Blobs (versions, owner icons, screenshots) ----------

export interface Blobs {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, data: Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------- Runtime (ABI v2: one JS bundle per version) ----------

/** A loadable implementation: an ESM bundle exporting `operations`, identified by its hash. */
export interface CodeRef {
  hash: string;
  js: string;
}

/**
 * Whose state a call runs against. `scratch` names a throwaway (or backup) state next to the
 * capability's live state: "test:<build>", "dryrun:<build>", "backup:before-v3-…".
 */
export interface StateRef {
  capabilityId: string;
  scratch?: string;
}

export interface ExecutionTarget {
  capabilityId: string;
  code: CodeRef;
  state: StateRef;
  /** Granted secret values for this call. */
  secrets?: Record<string, string>;
  /** The owner's values for declared config (non-secret settings). */
  config?: Record<string, string>;
  /** Hosts the capability may reach (empty = no network). */
  hosts?: string[];
  /** Passed to handlers as ctx.caller (informational provenance). */
  caller?: { kind: string; id: string };
  /** When the whole call chain must finish (the outermost call's; model waiting extends it). */
  deadline?: Deadline;
  /** A widget's call: statements that would write the state are refused and secret updates dropped. */
  readOnly?: boolean;
}

/** A capability → capability call made by running code, routed by the platform. */
export interface CapabilityCall {
  capabilityId: string;
  operation: string;
  input: unknown;
}
export type CallHandler = (call: CapabilityCall) => Promise<unknown>;

export interface InvocationResult {
  output: unknown;
  /** Refreshed secret values the capability asks the platform to store. */
  secretUpdates: Record<string, string>;
  /** The capability's own console lines ("| " / "! " prefixed), capped. */
  logs: string[];
}

export interface CapabilityRuntime {
  /** `onModel` backs ctx.model; absent, the capability's ctx has no `model` (ABI gate, or not declared). */
  invoke(target: ExecutionTarget, operationKey: string, input: unknown, onCall?: CallHandler, onModel?: ModelHandler): Promise<InvocationResult>;
  /** Operation keys (`name@version`) the bundle actually exports. */
  describe(code: CodeRef): Promise<string[]>;
  /**
   * Apply not-yet-applied migrations to a state, each atomically. Returns the names applied.
   * `code` is the version the state is being prepared for (runtimes that keep state inside the
   * implementation's own object, like Durable Object facets, need it).
   */
  migrate(state: StateRef, migrations: Migration[], code: CodeRef): Promise<string[]>;
  hasState(state: StateRef): Promise<boolean>;
  /** Consistent copy (dry runs, backups). */
  copyState(from: StateRef, to: StateRef): Promise<void>;
  dropState(state: StateRef): Promise<void>;
  /** Scratch states of a capability whose name starts with `prefix`. */
  listStates(capabilityId: string, prefix: string): Promise<string[]>;
  /** Insert exported rows (dumpState's shape) into a state's tables, which must exist and be empty. */
  loadState(state: StateRef, tables: Record<string, Record<string, unknown>[]>, code: CodeRef): Promise<number>;
  /** Every user table as JSON rows (platform export), read through the active version `code`. */
  dumpState(state: StateRef, code: CodeRef): Promise<Record<string, Record<string, unknown>[]>>;
  /** Rows per user table, without reading them (Info › Data). */
  countState(state: StateRef, code: CodeRef): Promise<Record<string, number>>;
}

// ---------- Workbench (where builders run: the Node process, or the supervisor) ----------

export interface BuildJob {
  buildId: string;
  capabilityId: string;
  kind: "create" | "modify" | "widgets";
  /** Which builder ("claude", "codex", or a host-provided one such as "copy:<dir>"). */
  builder: string;
  attempt: number;
  /** The first build of the chain this one retries (Retry or Ask builder to fix, by hand or after a restart). Unset: not a retry. */
  retryOf?: string;
  /** Validation log from the previous attempt, if it failed. */
  feedback?: string;
  /** The model to build with: a name the builder's CLI takes (an alias or a full name). Unset: the CLI's default. */
  model?: string;
  /** Reasoning effort, as the builder's CLI names it (low, medium, high …). Unset: the model's default. */
  effort?: string;
  /**
   * A pass on a candidate that already validated (see passes.ts): what it asks of the builder, with
   * screenshots of the candidate in the workspace's `screenshots/`. The builder resumes its session
   * with `request` when it can, else starts afresh with it after the usual prompt. Unset: an attempt.
   */
  pass?: BuildPass;
}

/** A pass's attempt: which pass, and what it asks. */
export interface BuildPass {
  name: Pass;
  request: string;
}

/**
 * How a build went, beyond its files: `onModel` names the model it actually ran on (a family such as
 * "fable" resolves to a full name).
 */
export interface BuildHooks {
  onActivity: (line: string) => void;
  signal: AbortSignal;
  onModel?: (model: string) => void;
  /** What the builder's host charged for this attempt, in the unit the owner sees (e.g. points). */
  onCharge?: (charge: BuildCharge) => void;
  /**
   * Check the work in progress as validation will, when the builder asks (its `check` tool): offered
   * to the builder only when set. `id` is the builder's name for the call.
   */
  onCheck?: (id: string) => Promise<CheckResult>;
}

/** What a builder's check of its work in progress found. */
export interface CheckResult {
  passed: boolean;
  /** What the builder reads: PASS or FAIL, every failure, what was measured on the UI, what passed. */
  text: string;
  failures: string[];
  /** Measured on the UI: what sticks out or is cut short, page errors, controls that break the page. */
  defects: string[];
  /** The UI filled with its sample data: desktop-light, desktop-dark, mobile-light, mobile-dark (none when it didn't render). */
  images: VisualShot[];
}

/** A host's charge for a build, as the owner sees it ("12 points"); Hewn shows it as given. */
export interface BuildCharge {
  amount: number;
  unit: string;
}

export interface Workbench {
  /** Create the build's workspace with these seed files (skeleton, or a copy of the active version + BUILDER.md). */
  open(buildId: string, files: Files): Promise<void>;
  /** The candidate as it stands (build artefacts such as node_modules excluded). */
  read(buildId: string): Promise<Files>;
  /**
   * Copy a build's workspace into a new one (`to`) its builder can't reach: what a check of its work
   * in progress runs on (bundling with npm included) while the builder goes on writing its own.
   */
  snapshot(buildId: string, to: string): Promise<void>;
  /** One workspace file, if present (e.g. the icon a builder writes first). */
  file(buildId: string, path: string): Promise<Uint8Array | undefined>;
  remove(buildId: string): Promise<void>;
  /**
   * Run a builder in the workspace. Throws; `unavailable: true` on the error means retrying won't
   * help, `refused: true` that the builder's host declined it (e.g. over quota; the message says why),
   * `paused: true` that the builder's host paused it part-way with its work kept (the owner continues
   * or stops it; the message says why), and `modelUnavailable: true` that the model asked for can't
   * run (the owner picks another).
   */
  build(job: BuildJob, hooks: BuildHooks): Promise<void>;
  /** Bundle the workspace's src/index.ts (and npm dependencies) into one ESM module. */
  bundle(buildId: string): Promise<{ js: string; log: string[] }>;
  /** Append a line to the build's human-readable transcript. */
  note(buildId: string, line: string): Promise<void>;
  transcript(buildId: string): Promise<string | undefined>;
  removeTranscript(buildId: string): Promise<void>;
  /** Replace one folder of a build's workspace (`screenshots`) with `files`, their paths inside it: what a pass looks at. */
  writeFolder(buildId: string, folder: string, files: Files): Promise<void>;
  /** Render the candidate's UI headlessly (optional). */
  visualCheck?(buildId: string, args: VisualCheckArgs): Promise<VisualCheckResult>;
}

export interface VisualCheckArgs {
  manifest: unknown;
  /** Render these widgets (each in each size, from its test case's view) instead of the candidate's UI. */
  widgets?: VisualWidget[];
  invoke: (body: { operation: string; operationVersion?: number; input?: unknown }) => Promise<{ result: unknown }>;
  /** Also measure what a builder should fix: what sticks out or is cut short, and controls that break the page (clicks write to the state `invoke` runs on). */
  measure?: boolean;
}
export interface VisualWidget {
  name: string;
  title: string;
  sizes: string[];
  view: unknown;
}

export interface VisualCheckResult {
  skipped?: string;
  errors: string[];
  screenshot?: Uint8Array;
  /** The same screen in dark mode. */
  screenshotDark?: Uint8Array;
  /**
   * The UI whole, 1280 and 390 px wide, light and dark: "desktop-light", "desktop-dark", "mobile-light",
   * "mobile-dark", a long page in parts a model can read ("mobile-light-2" carries on from "mobile-light").
   */
  shots?: VisualShot[];
  /** With `measure`: what to fix, one line each. */
  defects?: string[];
}
export interface VisualShot {
  name: string;
  png: Uint8Array;
}

// ---------- Secrets & agents ----------

export interface SecretStore {
  get(capabilityId: string, name: string): string | undefined;
  set(capabilityId: string, name: string, value: string): void;
  delete(capabilityId: string, name: string): void;
  /** Stored secrets this home's key can't decrypt ("capability/NAME"): restored from another machine or home. */
  unreadable?(): string[];
}

